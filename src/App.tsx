import {
  Activity,
  ArrowDownUp,
  CheckCircle2,
  CircleDot,
  PlugZap,
  RefreshCcw,
  ShieldCheck,
  Wallet
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient
} from "viem";
import { bsc } from "viem/chains";
import { autonomousStrategyAbi, clPositionManagerAbi, swapEvent } from "./lib/abis";
import {
  approvePermit2Spender,
  approveTokenToPermit2,
  readApprovalState,
  type ApprovalState
} from "./lib/approvals";
import {
  BSC_CHAIN_ID,
  BSC_RPC_URL,
  DEADLINE_SECONDS,
  DEFAULT_POOL_ID,
  DEFAULT_SCAN_FROM_BLOCK,
  INFINITY_ADDRESSES,
  ZERO_ADDRESS
} from "./lib/constants";
import {
  buildBurnPayload,
  buildDecreasePayload,
  buildMintPayload,
  deadlineFromNow,
  formatTokenAmount,
  poolKeyToTuple
} from "./lib/encoding";
import {
  applySlippageDown,
  applySlippageUp,
  ceilUsableTick,
  floorUsableTick,
  formatCompact,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  offsetPercentToTicks,
  priceAtTick,
  sqrtPriceX96ToHumanPrice
} from "./lib/math";
import {
  createBscClient,
  describePrice,
  discoverPoolKey,
  loadPoolState
} from "./lib/pool";
import { readPositionById, scanOwnedPositions } from "./lib/positions";
import type { PoolState, PositionInfo, TokenInfo, TradeEvent } from "./lib/types";
import { deployWithWallet, writeWithWallet } from "./lib/wallet";
import {
  atomicExecutorBytecode,
  atomicExecutorCompiledAbi
} from "./generated/AtomicLiquidityExecutor";
import { atomicExecutorAbi } from "./lib/abis";

type LiquidityMode = "both" | "token0" | "token1";
type FollowSide = "below" | "above";
type ApprovalMap = Record<string, ApprovalState>;
type FollowRuntimeSettings = {
  side: FollowSide;
  offsetPercent: string;
  mintSafetyPercent: string;
  helperAddress: Address;
};
type ReceiptWithLogs = {
  logs: Array<{ address: Address; topics: readonly Hex[] }>;
};

const TRANSFER_TOPIC0 =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;

function useStoredState<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    const stored = localStorage.getItem(key);
    if (!stored) return initial;
    try {
      return JSON.parse(stored) as T;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);

  return [value, setValue] as const;
}

function normalizePercent(value: string, fallback: number): number {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseAmount(value: string, decimals: number): bigint {
  const clean = value.trim().replace(",", ".");
  if (!clean) return 0n;
  return parseUnits(clean, decimals);
}

function parseBlockNumber(value: string, fallback: bigint): bigint {
  const clean = value.trim().replaceAll("_", "");
  if (!/^\d+$/.test(clean)) return fallback;
  return BigInt(clean);
}

function tokenKey(token: Address, spender: Address) {
  return `${token.toLowerCase()}-${spender.toLowerCase()}`;
}

function nftApprovalKey(tokenId: bigint, helper: Address) {
  return `${tokenId.toString()}-${helper.toLowerCase()}`;
}

function nftOperatorApprovalKey(owner: Address, helper: Address) {
  return `${owner.toLowerCase()}-${helper.toLowerCase()}`;
}

function statusClass(message: string) {
  if (message.toLowerCase().includes("ошибка")) return "status error";
  if (message.toLowerCase().includes("готово")) return "status ok";
  return "status";
}

function computeRange(pool: PoolState, mode: LiquidityMode, offsetPercent: number) {
  const tickSpacing = Math.max(1, pool.tickSpacing);
  const offsetTicks = offsetPercentToTicks(offsetPercent);
  const anchor = pool.tick + offsetTicks;

  if (mode === "token0") {
    let lower = ceilUsableTick(anchor, tickSpacing);
    if (lower <= pool.tick) lower += tickSpacing;
    return { tickLower: lower, tickUpper: lower + tickSpacing };
  }

  if (mode === "token1") {
    let upper = floorUsableTick(anchor, tickSpacing);
    if (upper > pool.tick) upper -= tickSpacing;
    return { tickLower: upper - tickSpacing, tickUpper: upper };
  }

  const lower = floorUsableTick(anchor, tickSpacing);
  return { tickLower: lower, tickUpper: lower + tickSpacing };
}

function computeLiquidityPreview(args: {
  pool: PoolState;
  mode: LiquidityMode;
  offsetPercent: number;
  amount0: string;
  amount1: string;
  slippageBps: number;
}) {
  const { tickLower, tickUpper } = computeRange(args.pool, args.mode, args.offsetPercent);
  const sqrtLower = getSqrtRatioAtTick(tickLower);
  const sqrtUpper = getSqrtRatioAtTick(tickUpper);
  const amount0 =
    args.mode === "token1" ? 0n : parseAmount(args.amount0, args.pool.token0.decimals);
  const amount1 =
    args.mode === "token0" ? 0n : parseAmount(args.amount1, args.pool.token1.decimals);
  const liquidity = getLiquidityForAmounts(
    args.pool.sqrtPriceX96,
    sqrtLower,
    sqrtUpper,
    amount0,
    amount1
  );

  return {
    tickLower,
    tickUpper,
    sqrtLower,
    sqrtUpper,
    amount0,
    amount1,
    amount0Max: args.amount0 ? applySlippageUp(amount0, args.slippageBps) : 0n,
    amount1Max: args.amount1 ? applySlippageUp(amount1, args.slippageBps) : 0n,
    liquidity
  };
}

function pctToLiquidity(liquidity: bigint, percentText: string) {
  const percent = Math.min(100, Math.max(0, normalizePercent(percentText, 100)));
  return (liquidity * BigInt(Math.round(percent * 100))) / 10_000n;
}

function readableTrade(trade: TradeEvent, token0: TokenInfo, token1: TokenInfo) {
  const inputToken = trade.amount0 > 0n ? token0 : trade.amount1 > 0n ? token1 : null;
  const outputToken = trade.amount0 < 0n ? token0 : trade.amount1 < 0n ? token1 : null;
  const inputAmount = trade.amount0 > 0n ? trade.amount0 : trade.amount1 > 0n ? trade.amount1 : 0n;
  const outputAmount =
    trade.amount0 < 0n ? -trade.amount0 : trade.amount1 < 0n ? -trade.amount1 : 0n;

  return { inputToken, outputToken, inputAmount, outputAmount };
}

function topicToAddress(topic: Hex): Address {
  return getAddress(`0x${topic.slice(-40)}`);
}

function computeFollowRange(pool: PoolState, side: FollowSide, offsetPercent: number) {
  const offset = Math.abs(offsetPercent);
  return side === "below"
    ? computeRange(pool, "token1", -offset)
    : computeRange(pool, "token0", offset);
}

function extractMintedPositionIds(receipt: ReceiptWithLogs, owner: Address): bigint[] {
  const ownerLower = owner.toLowerCase();
  return receipt.logs
    .filter((log) => log.address.toLowerCase() === INFINITY_ADDRESSES.clPositionManager.toLowerCase())
    .filter((log) => log.topics[0]?.toLowerCase() === TRANSFER_TOPIC0.toLowerCase())
    .filter((log) => log.topics[1] && topicToAddress(log.topics[1]).toLowerCase() === ZERO_ADDRESS.toLowerCase())
    .filter((log) => log.topics[2] && topicToAddress(log.topics[2]).toLowerCase() === ownerLower)
    .map((log) => BigInt(log.topics[3] ?? 0n))
    .filter((tokenId) => tokenId > 0n);
}

export function App() {
  const [rpcUrl, setRpcUrl] = useStoredState("rpcUrl", BSC_RPC_URL);
  const [poolId, setPoolId] = useStoredState("poolId", DEFAULT_POOL_ID);
  const [scanFromBlock, setScanFromBlock] = useStoredState(
    "scanFromBlock",
    DEFAULT_SCAN_FROM_BLOCK.toString()
  );
  const [helperAddress, setHelperAddress] = useStoredState("helperAddress", "");
  const [strategyAddress, setStrategyAddress] = useStoredState("strategyAddress", "");
  const [strategyTokenId, setStrategyTokenId] = useStoredState("strategyTokenId", "");
  const [strategyWithdrawTo, setStrategyWithdrawTo] = useStoredState("strategyWithdrawTo", "");

  const [account, setAccount] = useState<Address | null>(null);
  const [walletClient, setWalletClient] = useState<WalletClient | null>(null);
  const [pool, setPool] = useState<PoolState | null>(null);
  const [positions, setPositions] = useState<PositionInfo[]>([]);
  const [approvals, setApprovals] = useState<ApprovalMap>({});
  const [nftApprovals, setNftApprovals] = useState<Record<string, boolean>>({});
  const [nftOperatorApprovals, setNftOperatorApprovals] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState("Готов к подключению MetaMask.");
  const [busy, setBusy] = useState(false);

  const [mode, setMode] = useState<LiquidityMode>("both");
  const [offsetPercent, setOffsetPercent] = useState("0");
  const [amount0, setAmount0] = useState("");
  const [amount1, setAmount1] = useState("");
  const [slippageBps, setSlippageBps] = useState("50");
  const [positionPercents, setPositionPercents] = useState<Record<string, string>>({});
  const [selectedPositionId, setSelectedPositionId] = useState<string>("");
  const [manualTokenId, setManualTokenId] = useState("");
  const [exitPercent, setExitPercent] = useState("100");
  const [sellCurrency, setSellCurrency] = useState<Address | "">("");
  const [minOut, setMinOut] = useState("");

  const [watching, setWatching] = useState(false);
  const [lastSeenBlock, setLastSeenBlock] = useState<bigint | null>(null);
  const [lastTrade, setLastTrade] = useState<TradeEvent | null>(null);
  const [rebalanceMinOut, setRebalanceMinOut] = useState("");
  const [rebalanceSafety, setRebalanceSafety] = useState("90");
  const [managedSide, setManagedSide] = useStoredState<FollowSide>("managedSide", "below");
  const [managedOffsetPercent, setManagedOffsetPercent] = useStoredState("managedOffsetPercent", "0.2");
  const [managedAmount, setManagedAmount] = useState("");
  const [managedWithdrawPercent, setManagedWithdrawPercent] = useState("100");
  const [followSide, setFollowSide] = useStoredState<FollowSide>("followSide", "below");
  const [followOffsetPercent, setFollowOffsetPercent] = useStoredState("followOffsetPercent", "0.2");
  const [followSafety, setFollowSafety] = useStoredState("followSafety", "98");
  const [followCheckSeconds, setFollowCheckSeconds] = useStoredState("followCheckSeconds", "8");
  const [followWatching, setFollowWatching] = useState(false);
  const [followRuntimeSettings, setFollowRuntimeSettings] = useState<FollowRuntimeSettings | null>(null);
  const [followLastCheck, setFollowLastCheck] = useState("Не запущен.");

  const client = useMemo(() => createBscClient(rpcUrl), [rpcUrl]);

  const currentPosition =
    positions.find((item) => item.tokenId.toString() === selectedPositionId) ??
    positions[0] ??
    null;
  const helperAddressValid = Boolean(helperAddress && isAddress(helperAddress));
  const normalizedHelperAddress = helperAddressValid ? getAddress(helperAddress) : null;
  const strategyAddressValid = Boolean(strategyAddress && isAddress(strategyAddress));
  const currentNftOperatorApproved =
    Boolean(account && normalizedHelperAddress) &&
    nftOperatorApprovals[
      nftOperatorApprovalKey(account ?? ZERO_ADDRESS, normalizedHelperAddress ?? ZERO_ADDRESS)
    ] === true;
  const currentNftApproved =
    currentNftOperatorApproved ||
    Boolean(currentPosition && normalizedHelperAddress) &&
    nftApprovals[
      nftApprovalKey(currentPosition?.tokenId ?? 0n, normalizedHelperAddress ?? ZERO_ADDRESS)
    ] === true;
  const nftApprovalLabel = currentNftOperatorApproved
    ? "Approve all NFT готов"
    : currentNftApproved
      ? "Текущая NFT разрешена"
      : "Нужен Approve all NFT";
  const approveAllButtonLabel = currentNftOperatorApproved ? "Approve all готов" : "Approve all NFT";

  const inferredSellCurrency = useMemo(() => {
    if (!pool) return "";
    if (pool.token0.symbol.toUpperCase().includes("NES")) return pool.token0.address;
    if (pool.token1.symbol.toUpperCase().includes("NES")) return pool.token1.address;
    return pool.token0.address;
  }, [pool]);

  useEffect(() => {
    if (!sellCurrency && inferredSellCurrency) setSellCurrency(inferredSellCurrency);
  }, [inferredSellCurrency, sellCurrency]);

  useEffect(() => {
    if (!selectedPositionId && positions[0]) {
      setSelectedPositionId(positions[0].tokenId.toString());
    }
  }, [positions, selectedPositionId]);

  const preview = useMemo(() => {
    if (!pool) return null;
    try {
      return computeLiquidityPreview({
        pool,
        mode,
        offsetPercent: normalizePercent(offsetPercent, 0),
        amount0,
        amount1,
        slippageBps: Math.max(0, Math.floor(normalizePercent(slippageBps, 50)))
      });
    } catch {
      return null;
    }
  }, [amount0, amount1, mode, offsetPercent, pool, slippageBps]);

  const followPreview = useMemo(() => {
    if (!pool) return null;
    const range = computeFollowRange(pool, followSide, normalizePercent(followOffsetPercent, 0.2));
    const drift = currentPosition
      ? Math.max(
          Math.abs(currentPosition.tickLower - range.tickLower),
          Math.abs(currentPosition.tickUpper - range.tickUpper)
        )
      : 0;
    return {
      ...range,
      drift,
      needsMove: Boolean(currentPosition && drift >= Math.max(1, pool.tickSpacing)),
      targetToken: followSide === "below" ? pool.token1 : pool.token0
    };
  }, [currentPosition, followOffsetPercent, followSide, pool]);

  const atomicPreview = useMemo(() => {
    if (!pool || !currentPosition) return null;
    const sell = sellCurrency ? getAddress(sellCurrency) : inferredSellCurrency;
    const sellIsToken0 = sell.toLowerCase() === pool.token0.address.toLowerCase();
    const sellToken = sellIsToken0 ? pool.token0 : pool.token1;
    const buyToken = sellIsToken0 ? pool.token1 : pool.token0;
    const liquidity = pctToLiquidity(currentPosition.liquidity, exitPercent);
    const amounts = getAmountsForLiquidity(
      pool.sqrtPriceX96,
      getSqrtRatioAtTick(currentPosition.tickLower),
      getSqrtRatioAtTick(currentPosition.tickUpper),
      liquidity
    );
    const sellAmount = sellIsToken0 ? amounts.amount0 : amounts.amount1;

    return {
      buyToken,
      liquidity,
      poolLabel: `${pool.token0.symbol}/${pool.token1.symbol}`,
      sellAmount,
      sellToken,
      withdrawnAmount0: amounts.amount0,
      withdrawnAmount1: amounts.amount1
    };
  }, [currentPosition, exitPercent, inferredSellCurrency, pool, sellCurrency]);

  const managedPreview = useMemo(() => {
    if (!pool) return null;
    try {
      const offset = Math.abs(normalizePercent(managedOffsetPercent, 0.2));
      const range = computeFollowRange(pool, managedSide, offset);
      const targetToken = managedSide === "below" ? pool.token1 : pool.token0;
      const amount = parseAmount(managedAmount, targetToken.decimals);
      const amount0 = managedSide === "above" ? amount : 0n;
      const amount1 = managedSide === "below" ? amount : 0n;
      const bps = Math.max(0, Math.floor(normalizePercent(slippageBps, 50)));
      const liquidity = getLiquidityForAmounts(
        pool.sqrtPriceX96,
        getSqrtRatioAtTick(range.tickLower),
        getSqrtRatioAtTick(range.tickUpper),
        amount0,
        amount1
      );

      return {
        ...range,
        amount,
        amount0,
        amount1,
        amount0Max: amount0 > 0n ? applySlippageUp(amount0, bps) : 0n,
        amount1Max: amount1 > 0n ? applySlippageUp(amount1, bps) : 0n,
        liquidity,
        targetToken
      };
    } catch {
      return null;
    }
  }, [managedAmount, managedOffsetPercent, managedSide, pool, slippageBps]);

  const managedApproval = managedPreview
    ? approvals[tokenKey(managedPreview.targetToken.address, INFINITY_ADDRESSES.clPositionManager)]
    : undefined;
  const managedTokenApproved = Boolean(
    managedPreview &&
      managedPreview.amount > 0n &&
      managedApproval &&
      managedApproval.erc20Allowance >= managedPreview.amount &&
      managedApproval.permit2Allowance >= managedPreview.amount
  );
  const managedTokenApprovalLabel = !managedPreview
    ? "Token approve needed"
    : managedPreview.amount <= 0n
      ? "Укажите сумму"
      : managedTokenApproved
        ? "Token approved"
        : "Token approve needed";
  const managedApproveButtonLabel = managedTokenApproved
    ? "Token approved"
    : `Approve ${managedPreview?.targetToken.symbol ?? (managedSide === "below" ? "USDT" : "NES")}`;

  const selectedPositionStats = useMemo(() => {
    if (!pool || !currentPosition) return null;
    const amounts = getAmountsForLiquidity(
      pool.sqrtPriceX96,
      getSqrtRatioAtTick(currentPosition.tickLower),
      getSqrtRatioAtTick(currentPosition.tickUpper),
      currentPosition.liquidity
    );
    const price = sqrtPriceX96ToHumanPrice(
      pool.sqrtPriceX96,
      pool.token0.decimals,
      pool.token1.decimals
    );
    const value0 = Number(formatUnits(amounts.amount0, pool.token0.decimals)) * price;
    const value1 = Number(formatUnits(amounts.amount1, pool.token1.decimals));

    return {
      ...amounts,
      valueUsdt: value0 + value1,
      inRange: pool.tick >= currentPosition.tickLower && pool.tick < currentPosition.tickUpper
    };
  }, [currentPosition, pool]);

  async function ensureBsc() {
    if (!window.ethereum) throw new Error("MetaMask не найден.");
    const chainId = await window.ethereum.request({ method: "eth_chainId" });
    if (chainId === "0x38") return;
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0x38" }]
      });
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code !== 4902) throw error;
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: "0x38",
            chainName: "BNB Smart Chain",
            nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
            rpcUrls: [BSC_RPC_URL],
            blockExplorerUrls: ["https://bscscan.com"]
          }
        ]
      });
    }
  }

  async function connectWallet() {
    if (!window.ethereum) {
      setStatus("Ошибка: MetaMask не найден в браузере.");
      return;
    }
    try {
      setBusy(true);
      await ensureBsc();
      const wc = createWalletClient({
        chain: bsc,
        transport: custom(window.ethereum)
      });
      const [connected] = await wc.requestAddresses();
      const chainId = await wc.getChainId();
      if (chainId !== BSC_CHAIN_ID) throw new Error("MetaMask должен быть в BNB Smart Chain.");
      setAccount(getAddress(connected));
      setWalletClient(wc);
      setStatus("Кошелёк подключён. Теперь загрузите пул.");
    } catch (error) {
      setStatus(`Ошибка подключения: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadPool() {
    try {
      setBusy(true);
      setStatus("Ищу PoolKey и читаю состояние пула...");
      const fromBlock = parseBlockNumber(scanFromBlock, DEFAULT_SCAN_FROM_BLOCK);
      const key = await discoverPoolKey(client, poolId as Hex, fromBlock);
      const state = await loadPoolState(client, poolId as Hex, key, account ?? undefined);
      setPool(state);
      setStatus("Пул загружен, диапазоны и балансы готовы.");
      if (account) await refreshPositionsAndApprovals(client, state, account);
    } catch (error) {
      setStatus(`Ошибка загрузки пула: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function refreshPositionsAndApprovals(
    nextClient: PublicClient = client,
    nextPool: PoolState | null = pool,
    owner: Address | null = account
  ) {
    if (!nextPool || !owner) return;
    try {
      setBusy(true);
      const knownTokenIds = positions.map((position) => position.tokenId);
      const [nextPoolState, knownPositions, approval0, approval1] = await Promise.all([
        loadPoolState(nextClient, nextPool.poolId, nextPool.poolKey, owner),
        Promise.all(
          knownTokenIds.map((tokenId) =>
            readPositionById({
              client: nextClient,
              tokenId,
              owner,
              poolId: nextPool.poolId
            })
          )
        ),
        readApprovalState({
          client: nextClient,
          owner,
          token: nextPool.token0.address,
          spender: INFINITY_ADDRESSES.clPositionManager
        }),
        readApprovalState({
          client: nextClient,
          owner,
          token: nextPool.token1.address,
          spender: INFINITY_ADDRESSES.clPositionManager
        })
      ]);
      setPool(nextPoolState);
      setPositions(
        knownPositions.filter((position): position is PositionInfo => Boolean(position))
      );
      setApprovals({
        [tokenKey(nextPool.token0.address, INFINITY_ADDRESSES.clPositionManager)]: approval0,
        [tokenKey(nextPool.token1.address, INFINITY_ADDRESSES.clPositionManager)]: approval1
      });
      setStatus("Готово: балансы, approve и позиции обновлены.");
    } catch (error) {
      setStatus(`Ошибка обновления: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function addMintedPositionsFromReceipt(
    receipt: ReceiptWithLogs,
    removedTokenId?: bigint
  ) {
    if (!pool || !account) return;
    const mintedIds = extractMintedPositionIds(receipt, account);
    const minted = (
      await Promise.all(
        mintedIds.map((tokenId) =>
          readPositionById({
            client,
            tokenId,
            owner: account,
            poolId: pool.poolId
          })
        )
      )
    ).filter((position): position is PositionInfo => Boolean(position));

    if (minted.length === 0 && !removedTokenId) return;
    setPositions((prev) => {
      const next = prev.filter((position) => position.tokenId !== removedTokenId);
      for (const position of minted) {
        const existingIndex = next.findIndex((item) => item.tokenId === position.tokenId);
        if (existingIndex >= 0) next[existingIndex] = position;
        else next.push(position);
      }
      return next.sort((a, b) => Number(a.tokenId - b.tokenId));
    });
    if (minted[0]) setSelectedPositionId(minted[0].tokenId.toString());
  }

  async function addManualPosition() {
    if (!pool || !account) return;
    try {
      setBusy(true);
      const tokenId = BigInt(manualTokenId.trim());
      const position = await readPositionById({
        client,
        tokenId,
        owner: account,
        poolId: pool.poolId
      });
      if (!position) {
        throw new Error("Позиция не найдена, не принадлежит кошельку или относится к другому poolId.");
      }
      setPositions((prev) => {
        const rest = prev.filter((item) => item.tokenId !== tokenId);
        return [...rest, position].sort((a, b) => Number(a.tokenId - b.tokenId));
      });
      setSelectedPositionId(tokenId.toString());
      setStatus("Готово: позиция добавлена.");
    } catch (error) {
      setStatus(`Ошибка tokenId: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function scanPositionsFromLogs() {
    if (!pool || !account) return;
    try {
      setBusy(true);
      setStatus("Готовлю поиск NFT-позиций по Transfer-логам...");
      const latestBlock = await client.getBlockNumber();
      let fromBlock = parseBlockNumber(scanFromBlock, DEFAULT_SCAN_FROM_BLOCK);
      if (fromBlock > latestBlock) {
        const fallbackBlock = DEFAULT_SCAN_FROM_BLOCK < latestBlock ? DEFAULT_SCAN_FROM_BLOCK : 0n;
        fromBlock = fallbackBlock;
        setScanFromBlock(fallbackBlock.toString());
        setStatus(
          `Scan from block был больше текущего блока сети (${latestBlock.toString()}). Сканирую с ${fallbackBlock.toString()}.`
        );
      } else {
        setStatus(
          `Сканирую NFT-позиции с блока ${fromBlock.toString()} до ${latestBlock.toString()}. Это может занять время.`
        );
      }

      let lastProgressAt = 0;
      const ownedPositions = await scanOwnedPositions({
        client,
        owner: account,
        poolId: pool.poolId,
        fromBlock,
        toBlock: latestBlock,
        onProgress: (progress) => {
          const now = Date.now();
          if (now - lastProgressAt < 1200 && progress.toBlock !== latestBlock) return;
          lastProgressAt = now;
          setStatus(
            `Сканирую Transfer-логи: ${progress.toBlock.toString()} / ${progress.latestBlock.toString()}. Найдено NFT: ${progress.foundTokenIds}.`
          );
        }
      });
      setPositions(ownedPositions);
      setStatus(
        ownedPositions.length > 0
          ? `Готово: найдено позиций по этому poolId: ${ownedPositions.length}.`
          : "Готово: позиции не найдены. Проверьте кошелёк, poolId и Scan from block; если знаете NFT tokenId, добавьте его вручную."
      );
    } catch (error) {
      setStatus(`Ошибка сканирования: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function approveForAdd(token: Address) {
    if (!walletClient || !account || !pool) return;
    try {
      setBusy(true);
      setStatus("Подтвердите ERC20 approve для Permit2...");
      const hash1 = await approveTokenToPermit2({ walletClient, account, token });
      await client.waitForTransactionReceipt({ hash: hash1 });
      setStatus("Теперь подтвердите Permit2 approve для CL Position Manager...");
      const hash2 = await approvePermit2Spender({
        walletClient,
        account,
        token,
        spender: INFINITY_ADDRESSES.clPositionManager
      });
      await client.waitForTransactionReceipt({ hash: hash2 });
      await refreshPositionsAndApprovals();
    } catch (error) {
      setStatus(`Ошибка approve: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function mintPosition() {
    if (!walletClient || !account || !pool || !preview) return;
    try {
      if (preview.liquidity <= 0n) {
        throw new Error("Ликвидность равна нулю. Проверьте суммы и положение диапазона.");
      }
      setBusy(true);
      const payload = buildMintPayload({
        poolKey: pool.poolKey,
        tickLower: preview.tickLower,
        tickUpper: preview.tickUpper,
        liquidity: preview.liquidity,
        amount0Max: preview.amount0Max,
        amount1Max: preview.amount1Max,
        owner: account
      });
      setStatus("Подтвердите mint позиции в MetaMask...");
      const hash = await writeWithWallet(walletClient, {
        address: INFINITY_ADDRESSES.clPositionManager,
        abi: clPositionManagerAbi,
        functionName: "modifyLiquidities",
        args: [payload, deadlineFromNow(DEADLINE_SECONDS)],
        account
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      await addMintedPositionsFromReceipt(receipt as ReceiptWithLogs);
      const nextPool = await loadPoolState(client, pool.poolId, pool.poolKey, account);
      setPool(nextPool);
    } catch (error) {
      setStatus(`Ошибка mint: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function mintManagedPosition() {
    if (!walletClient || !account || !pool || !managedPreview) return;
    try {
      if (managedPreview.amount <= 0n) {
        throw new Error("Укажите сумму для добавления ликвидности.");
      }
      if (managedPreview.liquidity <= 0n) {
        throw new Error("Ликвидность равна нулю. Проверьте сумму и смещение от цены.");
      }
      if (!managedTokenApproved) {
        throw new Error(`Сначала сделайте Approve для ${managedPreview.targetToken.symbol}.`);
      }

      setBusy(true);
      setStatus(
        `Подтвердите добавление ${managedPreview.targetToken.symbol} в выбранный диапазон в MetaMask...`
      );
      const payload = buildMintPayload({
        poolKey: pool.poolKey,
        tickLower: managedPreview.tickLower,
        tickUpper: managedPreview.tickUpper,
        liquidity: managedPreview.liquidity,
        amount0Max: managedPreview.amount0Max,
        amount1Max: managedPreview.amount1Max,
        owner: account
      });
      const hash = await writeWithWallet(walletClient, {
        address: INFINITY_ADDRESSES.clPositionManager,
        abi: clPositionManagerAbi,
        functionName: "modifyLiquidities",
        args: [payload, deadlineFromNow(DEADLINE_SECONDS)],
        account
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      await addMintedPositionsFromReceipt(receipt as ReceiptWithLogs);
      const nextPool = await loadPoolState(client, pool.poolId, pool.poolKey, account);
      setPool(nextPool);
      setManagedAmount("");
      setStatus("Готово: ликвидность добавлена в выбранный диапазон.");
    } catch (error) {
      setStatus(`Ошибка добавления диапазона: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function removePosition(position: PositionInfo, burn: boolean, percentOverride?: string) {
    if (!walletClient || !account || !pool) return;
    try {
      setBusy(true);
      const percent = burn ? "100" : percentOverride ?? positionPercents[position.tokenId.toString()] ?? "100";
      const liquidity = burn ? position.liquidity : pctToLiquidity(position.liquidity, percent);
      if (liquidity <= 0n) throw new Error("Выбрано 0 ликвидности.");
      const amounts = getAmountsForLiquidity(
        pool.sqrtPriceX96,
        getSqrtRatioAtTick(position.tickLower),
        getSqrtRatioAtTick(position.tickUpper),
        liquidity
      );
      const bps = Math.max(0, Math.floor(normalizePercent(slippageBps, 50)));
      const payload = burn
        ? buildBurnPayload({
            poolKey: pool.poolKey,
            tokenId: position.tokenId,
            amount0Min: applySlippageDown(amounts.amount0, bps),
            amount1Min: applySlippageDown(amounts.amount1, bps),
            recipient: account
          })
        : buildDecreasePayload({
            poolKey: pool.poolKey,
            tokenId: position.tokenId,
            liquidity,
            amount0Min: applySlippageDown(amounts.amount0, bps),
            amount1Min: applySlippageDown(amounts.amount1, bps),
            recipient: account
          });
      setStatus(burn ? "Подтвердите полное закрытие позиции..." : "Подтвердите снятие ликвидности...");
      const hash = await writeWithWallet(walletClient, {
        address: INFINITY_ADDRESSES.clPositionManager,
        abi: clPositionManagerAbi,
        functionName: "modifyLiquidities",
        args: [payload, deadlineFromNow(DEADLINE_SECONDS)],
        account
      });
      await client.waitForTransactionReceipt({ hash });
      const updated = await readPositionById({
        client,
        tokenId: position.tokenId,
        owner: account,
        poolId: pool.poolId
      });
      setPositions((prev) => {
        if (!updated) return prev.filter((item) => item.tokenId !== position.tokenId);
        const rest = prev.filter((item) => item.tokenId !== position.tokenId);
        return [...rest, updated].sort((a, b) => Number(a.tokenId - b.tokenId));
      });
      const nextPool = await loadPoolState(client, pool.poolId, pool.poolKey, account);
      setPool(nextPool);
    } catch (error) {
      setStatus(`Ошибка снятия: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function transferPositionToStrategy() {
    if (!walletClient || !account || !currentPosition) {
      setStatus("Ошибка strategy transfer: выберите позицию и подключите MetaMask.");
      return;
    }
    if (!strategyAddress || !isAddress(strategyAddress)) {
      setStatus("Ошибка strategy transfer: укажите strategy contract.");
      return;
    }
    try {
      setBusy(true);
      const strategy = getAddress(strategyAddress);
      setStatus(`Подтвердите передачу LP NFT #${currentPosition.tokenId.toString()} в strategy contract...`);
      const hash = await writeWithWallet(walletClient, {
        address: INFINITY_ADDRESSES.clPositionManager,
        abi: clPositionManagerAbi,
        functionName: "safeTransferFrom",
        args: [account, strategy, currentPosition.tokenId],
        account
      });
      await client.waitForTransactionReceipt({ hash });
      setPositions((prev) => prev.filter((position) => position.tokenId !== currentPosition.tokenId));
      setSelectedPositionId("");
      setStatus("Готово: LP NFT передана в strategy. Теперь автономный бот сможет управлять этой позицией.");
    } catch (error) {
      setStatus(`Ошибка strategy transfer: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function findStrategyActivePosition() {
    if (!pool || !strategyAddress || !isAddress(strategyAddress)) {
      setStatus("Ошибка strategy NFT: укажите strategy contract и загрузите пул.");
      return;
    }
    try {
      setBusy(true);
      const strategy = getAddress(strategyAddress);
      setStatus("Ищу активную NFT-позицию внутри strategy...");
      const nextTokenId = await client.readContract({
        address: INFINITY_ADDRESSES.clPositionManager,
        abi: clPositionManagerAbi,
        functionName: "nextTokenId"
      });
      const staleTokenId = await client.readContract({
        address: strategy,
        abi: autonomousStrategyAbi,
        functionName: "currentTokenId"
      });
      let active: PositionInfo | null = null;
      const candidates: bigint[] = [];
      const seen = new Set<string>();
      if (staleTokenId > 0n && staleTokenId + 1n < nextTokenId) {
        const forwardStop = staleTokenId + 500n < nextTokenId - 1n ? staleTokenId + 500n : nextTokenId - 1n;
        for (let tokenId = staleTokenId + 1n; tokenId <= forwardStop; tokenId += 1n) {
          candidates.push(tokenId);
          seen.add(tokenId.toString());
        }
      }
      const stopAt = nextTokenId > 500n ? nextTokenId - 500n : 1n;
      for (let tokenId = nextTokenId - 1n; tokenId >= stopAt; tokenId -= 1n) {
        if (seen.has(tokenId.toString())) continue;
        candidates.push(tokenId);
        seen.add(tokenId.toString());
      }
      for (let index = 0; index < candidates.length && !active; index += 100) {
        const batch = candidates.slice(index, index + 100);
        const owners = await client.multicall({
          allowFailure: true,
          contracts: batch.map((tokenId) => ({
            address: INFINITY_ADDRESSES.clPositionManager,
            abi: clPositionManagerAbi,
            functionName: "ownerOf",
            args: [tokenId]
          }))
        });
        for (let ownerIndex = 0; ownerIndex < owners.length; ownerIndex += 1) {
          const owner = owners[ownerIndex];
          if (owner.status !== "success") continue;
          if (getAddress(owner.result as Address) !== strategy) continue;
          active = await readPositionById({
            client,
            tokenId: batch[ownerIndex],
            owner: strategy,
            poolId: pool.poolId
          });
          if (active) break;
        }
      }
      if (!active) {
        throw new Error("Активная позиция strategy не найдена среди последних 500 NFT.");
      }
      setStrategyTokenId(active.tokenId.toString());
      setStatus(`Готово: активная NFT strategy найдена, tokenId #${active.tokenId.toString()}.`);
    } catch (error) {
      setStatus(`Ошибка поиска strategy NFT: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function setStrategyCurrentTokenId() {
    if (!walletClient || !account || !strategyAddress || !isAddress(strategyAddress)) {
      setStatus("Ошибка strategy tokenId: подключите MetaMask и укажите strategy contract.");
      return;
    }
    const clean = strategyTokenId.trim();
    if (!/^\d+$/.test(clean)) {
      setStatus("Ошибка strategy tokenId: укажите числовой NFT tokenId.");
      return;
    }
    try {
      setBusy(true);
      const tokenId = BigInt(clean);
      setStatus(`Подтвердите установку active tokenId #${tokenId.toString()} в strategy...`);
      const hash = await writeWithWallet(walletClient, {
        address: getAddress(strategyAddress),
        abi: autonomousStrategyAbi,
        functionName: "setCurrentTokenId",
        args: [tokenId],
        account
      });
      await client.waitForTransactionReceipt({ hash });
      setStatus(`Готово: strategy теперь смотрит на активную NFT #${tokenId.toString()}.`);
    } catch (error) {
      setStatus(`Ошибка установки strategy tokenId: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function withdrawStrategyCurrentPosition() {
    if (!walletClient || !account || !strategyAddress || !isAddress(strategyAddress)) {
      setStatus("Ошибка вывода strategy NFT: подключите MetaMask и укажите strategy contract.");
      return;
    }
    const recipient = strategyWithdrawTo.trim() ? strategyWithdrawTo.trim() : account;
    if (!isAddress(recipient)) {
      setStatus("Ошибка вывода strategy NFT: укажите корректный адрес получателя.");
      return;
    }
    try {
      setBusy(true);
      const to = getAddress(recipient);
      setStatus(`Подтвердите вывод текущей LP NFT из strategy на ${to}...`);
      const hash = await writeWithWallet(walletClient, {
        address: getAddress(strategyAddress),
        abi: autonomousStrategyAbi,
        functionName: "withdrawCurrentPosition",
        args: [to],
        account
      });
      await client.waitForTransactionReceipt({ hash });
      setStatus(`Готово: текущая LP NFT выведена из strategy на ${to}.`);
    } catch (error) {
      setStatus(`Ошибка вывода strategy NFT: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function deployHelper(): Promise<Address | null> {
    if (!walletClient || !account) return null;
    try {
      if (atomicExecutorBytecode === "0x") {
        throw new Error("Контракт ещё не скомпилирован. Запустите npm run compile:executor.");
      }
      setBusy(true);
      setStatus("Подтвердите развертывание AtomicLiquidityExecutor...");
      const hash = await deployWithWallet(walletClient, {
        abi: atomicExecutorCompiledAbi,
        bytecode: atomicExecutorBytecode,
        args: [
          INFINITY_ADDRESSES.clPositionManager,
          INFINITY_ADDRESSES.universalRouter,
          INFINITY_ADDRESSES.permit2
        ],
        account
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (!receipt.contractAddress) throw new Error("Контракт не вернул адрес.");
      setHelperAddress(receipt.contractAddress);
      setFollowLastCheck("Helper готов. Следующий шаг: Approve all NFT для LP-позиций.");
      setStatus("Готово: helper-контракт развернут и сохранен.");
      return receipt.contractAddress;
    } catch (error) {
      setStatus(`Ошибка helper deploy: ${(error as Error).message}`);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function ensureHelperAddress(): Promise<Address | null> {
    if (helperAddress && isAddress(helperAddress)) return getAddress(helperAddress);
    setFollowLastCheck("Helper не указан. Сейчас откроется MetaMask для создания helper.");
    setStatus("Нужно создать helper contract для перестановки диапазона.");
    return deployHelper();
  }

  async function approveAllNftsToHelper(helperOverride?: Address): Promise<boolean> {
    if (!walletClient || !account) {
      setStatus("Ошибка NFT approve all: сначала подключите MetaMask.");
      setFollowLastCheck("Сначала подключите MetaMask.");
      return false;
    }
    const helper = helperOverride ?? (await ensureHelperAddress());
    if (!helper) return false;
    try {
      setBusy(true);
      setStatus("Подтвердите Approve all NFT для helper в MetaMask...");
      setFollowLastCheck("Подтвердите Approve all NFT. Это нужно один раз для новых LP-позиций.");
      const hash = await writeWithWallet(walletClient, {
        address: INFINITY_ADDRESSES.clPositionManager,
        abi: clPositionManagerAbi,
        functionName: "setApprovalForAll",
        args: [helper, true],
        account
      });
      await client.waitForTransactionReceipt({ hash });
      setNftOperatorApprovals((prev) => ({
        ...prev,
        [nftOperatorApprovalKey(account, helper)]: true
      }));
      if (currentPosition) {
        setNftApprovals((prev) => ({
          ...prev,
          [nftApprovalKey(currentPosition.tokenId, helper)]: true
        }));
      }
      setFollowLastCheck("Approve all NFT готов. Следующий запрос будет на перестановку диапазона.");
      setStatus("Готово: helper может управлять всеми LP-NFT этого кошелька по вашему вызову.");
      return true;
    } catch (error) {
      setStatus(`Ошибка NFT approve all: ${(error as Error).message}`);
      setFollowLastCheck(`Ошибка approve all: ${(error as Error).message}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function refreshNftApproval(
    position: PositionInfo,
    helperOverride?: Address
  ): Promise<boolean> {
    if (!account) return false;
    const helper = helperOverride ?? (helperAddress && isAddress(helperAddress) ? getAddress(helperAddress) : null);
    if (!helper) return false;
    try {
      const [approved, approvedForAll] = await Promise.all([
        client.readContract({
          address: INFINITY_ADDRESSES.clPositionManager,
          abi: clPositionManagerAbi,
          functionName: "getApproved",
          args: [position.tokenId]
        }),
        client.readContract({
          address: INFINITY_ADDRESSES.clPositionManager,
          abi: clPositionManagerAbi,
          functionName: "isApprovedForAll",
          args: [account, helper]
        })
      ]);
      const isApproved =
        getAddress(approved).toLowerCase() === helper.toLowerCase() || Boolean(approvedForAll);
      setNftOperatorApprovals((prev) => ({
        ...prev,
        [nftOperatorApprovalKey(account, helper)]: Boolean(approvedForAll)
      }));
      setNftApprovals((prev) => ({
        ...prev,
        [nftApprovalKey(position.tokenId, helper)]: isApproved
      }));
      return isApproved;
    } catch {
      setNftOperatorApprovals((prev) => ({
        ...prev,
        [nftOperatorApprovalKey(account, helper)]: false
      }));
      setNftApprovals((prev) => ({
        ...prev,
        [nftApprovalKey(position.tokenId, helper)]: false
      }));
      return false;
    }
  }

  async function atomicExitAndSell(position: PositionInfo) {
    if (!walletClient || !account) {
      setStatus("Ошибка atomic exit: сначала подключите MetaMask.");
      return;
    }
    if (!pool) {
      setStatus("Ошибка atomic exit: сначала загрузите пул.");
      return;
    }
    const helper = await ensureHelperAddress();
    if (!helper) return;
    try {
      const approved = await refreshNftApproval(position, helper);
      if (!approved) {
        setStatus("NFT не разрешен. Сейчас откроется MetaMask для Approve all NFT...");
        const approvedNow = await approveAllNftsToHelper(helper);
        if (!approvedNow) {
          throw new Error("Approve all NFT не подтвержден. Операция отменена.");
        }
      }

      const sell = sellCurrency ? getAddress(sellCurrency) : inferredSellCurrency;
      const buy =
        sell.toLowerCase() === pool.token0.address.toLowerCase()
          ? pool.token1.address
          : pool.token0.address;
      const buyToken =
        buy.toLowerCase() === pool.token0.address.toLowerCase() ? pool.token0 : pool.token1;
      const liquidity = pctToLiquidity(position.liquidity, exitPercent);
      const amounts = getAmountsForLiquidity(
        pool.sqrtPriceX96,
        getSqrtRatioAtTick(position.tickLower),
        getSqrtRatioAtTick(position.tickUpper),
        liquidity
      );
      const bps = Math.max(0, Math.floor(normalizePercent(slippageBps, 50)));
      const amountOutMin = parseAmount(minOut, buyToken.decimals);
      const sellAmount =
        sell.toLowerCase() === pool.token0.address.toLowerCase() ? amounts.amount0 : amounts.amount1;
      if (sellAmount <= 0n) {
        throw new Error(
          `В снимаемой части позиции нет ${sell.toLowerCase() === pool.token0.address.toLowerCase() ? pool.token0.symbol : pool.token1.symbol} для продажи. Выберите другой sell token или другой диапазон/процент.`
        );
      }
      setBusy(true);
      setStatus("Подтвердите атомарное снятие и продажу в MetaMask...");
      const hash = await writeWithWallet(walletClient, {
        address: helper,
        abi: atomicExecutorAbi,
        functionName: "exitAndSwapToCurrency",
        args: [
          poolKeyToTuple(pool.poolKey),
          position.tokenId,
          liquidity,
          applySlippageDown(amounts.amount0, bps),
          applySlippageDown(amounts.amount1, bps),
          sell,
          buy,
          amountOutMin,
          deadlineFromNow(DEADLINE_SECONDS)
        ],
        account
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      await addMintedPositionsFromReceipt(receipt as ReceiptWithLogs, position.tokenId);
      const nextPool = await loadPoolState(client, pool.poolId, pool.poolKey, account);
      setPool(nextPool);
    } catch (error) {
      setStatus(`Ошибка atomic exit: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function executeFollowReposition(
    position: PositionInfo,
    basePool: PoolState | null = pool,
    settings?: { side: FollowSide; offsetPercent: string; mintSafetyPercent?: string; helperAddress?: Address }
  ) {
    if (!walletClient || !account) {
      setFollowLastCheck("Сначала подключите MetaMask.");
      setStatus("Ошибка follow-range: сначала подключите MetaMask.");
      return;
    }
    if (!basePool) {
      setFollowLastCheck("Сначала загрузите пул.");
      setStatus("Ошибка follow-range: сначала загрузите пул.");
      return;
    }
    const helper = settings?.helperAddress ?? (await ensureHelperAddress());
    if (!helper) return;
    try {
      setFollowLastCheck("Проверяю approve NFT для helper...");
      const approved = await refreshNftApproval(position, helper);
      if (!approved) {
        setFollowLastCheck("NFT не разрешен. Сейчас откроется MetaMask для Approve all NFT.");
        const approvedNow = await approveAllNftsToHelper(helper);
        if (!approvedNow) {
          throw new Error("Approve all NFT не подтвержден. Перестановка отменена.");
        }
      }

      const side = settings?.side ?? followSide;
      const offsetText = settings?.offsetPercent ?? followOffsetPercent;
      const mintSafetyText = settings?.mintSafetyPercent ?? followSafety;
      const freshPool = await loadPoolState(client, basePool.poolId, basePool.poolKey, account);
      const freshPosition =
        (await readPositionById({
          client,
          tokenId: position.tokenId,
          owner: account,
          poolId: freshPool.poolId
        })) ?? position;
      const target = computeFollowRange(
        freshPool,
        side,
        normalizePercent(offsetText, 0.2)
      );
      if (
        freshPosition.tickLower === target.tickLower &&
        freshPosition.tickUpper === target.tickUpper
      ) {
        setPool(freshPool);
        setFollowLastCheck("Диапазон уже на целевом смещении.");
        return;
      }

      const liquidityToRemove = freshPosition.liquidity;
      const removed = getAmountsForLiquidity(
        freshPool.sqrtPriceX96,
        getSqrtRatioAtTick(freshPosition.tickLower),
        getSqrtRatioAtTick(freshPosition.tickUpper),
        liquidityToRemove
      );
      const price = sqrtPriceX96ToHumanPrice(
        freshPool.sqrtPriceX96,
        freshPool.token0.decimals,
        freshPool.token1.decimals
      );
      const bps = Math.max(0, Math.floor(normalizePercent(slippageBps, 50)));
      const safety = Math.min(100, Math.max(1, normalizePercent(mintSafetyText, 98)));

      let swapInput = freshPool.token0.address;
      let swapOutput = freshPool.token1.address;
      let swapAmountIn = 0n;
      let swapAmountOutMin = 0n;
      let amount0After = removed.amount0;
      let amount1After = removed.amount1;

      if (side === "below" && removed.amount0 > 0n) {
        swapInput = freshPool.token0.address;
        swapOutput = freshPool.token1.address;
        swapAmountIn = removed.amount0;
        const estimatedOutHuman =
          Number(formatUnits(removed.amount0, freshPool.token0.decimals)) * price;
        swapAmountOutMin = parseUnits(
          Math.max(0, estimatedOutHuman * (1 - bps / 10_000)).toFixed(freshPool.token1.decimals),
          freshPool.token1.decimals
        );
        amount0After = 0n;
        amount1After += swapAmountOutMin;
      }

      if (side === "above" && removed.amount1 > 0n) {
        swapInput = freshPool.token1.address;
        swapOutput = freshPool.token0.address;
        swapAmountIn = removed.amount1;
        const estimatedOutHuman =
          Number(formatUnits(removed.amount1, freshPool.token1.decimals)) / price;
        swapAmountOutMin = parseUnits(
          Math.max(0, estimatedOutHuman * (1 - bps / 10_000)).toFixed(freshPool.token0.decimals),
          freshPool.token0.decimals
        );
        amount1After = 0n;
        amount0After += swapAmountOutMin;
      }

      const mintLiquidity =
        (getLiquidityForAmounts(
          freshPool.sqrtPriceX96,
          getSqrtRatioAtTick(target.tickLower),
          getSqrtRatioAtTick(target.tickUpper),
          amount0After,
          amount1After
        ) *
          BigInt(Math.round(safety * 100))) /
        10_000n;

      if (mintLiquidity <= 0n) {
        throw new Error("После снятия/обмена не получается заминтить новую позицию.");
      }

      setBusy(true);
      setFollowLastCheck("Ожидаю подпись MetaMask для перестановки диапазона.");
      const hash = await writeWithWallet(walletClient, {
        address: helper,
        abi: atomicExecutorAbi,
        functionName: "rebalance",
        args: [
          poolKeyToTuple(freshPool.poolKey),
          freshPosition.tokenId,
          liquidityToRemove,
          applySlippageDown(removed.amount0, bps),
          applySlippageDown(removed.amount1, bps),
          swapInput,
          swapOutput,
          swapAmountIn,
          swapAmountOutMin,
          target.tickLower,
          target.tickUpper,
          mintLiquidity,
          amount0After,
          amount1After,
          deadlineFromNow(DEADLINE_SECONDS)
        ],
        account
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      await addMintedPositionsFromReceipt(receipt as ReceiptWithLogs, freshPosition.tokenId);
      const nextPool = await loadPoolState(client, freshPool.poolId, freshPool.poolKey, account);
      setPool(nextPool);
      setFollowLastCheck(`Готово: диапазон переставлен в tx ${hash.slice(0, 10)}…`);
      setStatus("Готово: follow-range переставил ликвидность.");
    } catch (error) {
      setFollowLastCheck(`Ошибка: ${(error as Error).message}`);
      setStatus(`Ошибка follow-range: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleFollowService() {
    if (followWatching) {
      setFollowWatching(false);
      setFollowRuntimeSettings(null);
      setFollowLastCheck("Сервис остановлен.");
      return;
    }
    if (!currentPosition || !pool) {
      setFollowLastCheck("Сначала выберите активную позицию и загрузите пул.");
      return;
    }
    if (!walletClient || !account) {
      setFollowLastCheck("Сначала подключите MetaMask.");
      return;
    }
    const helper = await ensureHelperAddress();
    if (!helper) return;
    const approved = await refreshNftApproval(currentPosition, helper);
    if (!approved) {
      setFollowLastCheck("Сначала нужно Approve all NFT. Открываю MetaMask...");
      const approvedNow = await approveAllNftsToHelper(helper);
      if (!approvedNow) return;
    }
    setFollowRuntimeSettings({
      side: followSide,
      offsetPercent: followOffsetPercent,
      mintSafetyPercent: followSafety,
      helperAddress: helper
    });
    setFollowWatching(true);
    setFollowLastCheck("Сервис запущен. Проверяю цену и диапазон.");
  }

  async function startManagedRangeService() {
    if (followWatching) {
      setFollowWatching(false);
      setFollowRuntimeSettings(null);
      setFollowLastCheck("Сервис остановлен.");
      return;
    }
    if (!currentPosition || !pool) {
      setFollowLastCheck("Сначала выберите активную позицию и загрузите пул.");
      return;
    }
    if (!walletClient || !account) {
      setFollowLastCheck("Сначала подключите MetaMask.");
      return;
    }
    const helper = await ensureHelperAddress();
    if (!helper) return;
    const approved = await refreshNftApproval(currentPosition, helper);
    if (!approved) {
      setFollowLastCheck("Сначала нужно Approve all NFT. Открываю MetaMask...");
      const approvedNow = await approveAllNftsToHelper(helper);
      if (!approvedNow) return;
    }
    setFollowSide(managedSide);
    setFollowOffsetPercent(managedOffsetPercent);
    setFollowRuntimeSettings({
      side: managedSide,
      offsetPercent: managedOffsetPercent,
      mintSafetyPercent: "100",
      helperAddress: helper
    });
    setFollowWatching(true);
    setFollowLastCheck("Сервис запущен с настройками этого блока.");
  }

  useEffect(() => {
    if (!followWatching || !pool || !account || !walletClient || !currentPosition) return;
    const activeHelper =
      followRuntimeSettings?.helperAddress ??
      (helperAddress && isAddress(helperAddress) ? getAddress(helperAddress) : null);
    if (!activeHelper) {
      setFollowLastCheck("Helper не найден. Запустите сервис снова, чтобы создать helper.");
      setFollowWatching(false);
      return;
    }

    let cancelled = false;
    const intervalMs = Math.max(1, normalizePercent(followCheckSeconds, 8)) * 1000;
    const runtimeSettings = followRuntimeSettings ?? {
      side: followSide,
      offsetPercent: followOffsetPercent,
      mintSafetyPercent: followSafety,
      helperAddress: activeHelper
    };
    const poll = async () => {
      if (busy || cancelled) return;
      try {
        const freshPool = await loadPoolState(client, pool.poolId, pool.poolKey, account);
        const freshPosition = await readPositionById({
          client,
          tokenId: currentPosition.tokenId,
          owner: account,
          poolId: pool.poolId
        });
        if (!freshPosition) {
          setFollowLastCheck("Текущая NFT-позиция больше не активна.");
          return;
        }
        if (cancelled) return;
        setPool(freshPool);
        const target = computeFollowRange(
          freshPool,
          runtimeSettings.side,
          normalizePercent(runtimeSettings.offsetPercent, 0.2)
        );
        const drift = Math.max(
          Math.abs(freshPosition.tickLower - target.tickLower),
          Math.abs(freshPosition.tickUpper - target.tickUpper)
        );
        setFollowLastCheck(
          `Проверено: tick ${freshPool.tick}, цель ${target.tickLower} → ${target.tickUpper}.`
        );
        if (drift >= Math.max(1, freshPool.tickSpacing)) {
          await executeFollowReposition(freshPosition, freshPool, runtimeSettings);
        }
      } catch (error) {
        setFollowLastCheck(`Ошибка: ${(error as Error).message}`);
      }
    };

    const timer = window.setInterval(poll, intervalMs);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    account,
    busy,
    client,
    currentPosition,
    followCheckSeconds,
    followOffsetPercent,
    followRuntimeSettings,
    followSafety,
    followSide,
    followWatching,
    helperAddress,
    pool,
    walletClient
  ]);

  useEffect(() => {
    if (!currentPosition || !account || !helperAddress || !isAddress(helperAddress)) return;
    void refreshNftApproval(currentPosition);
  }, [account, client, currentPosition?.tokenId, helperAddress]);

  useEffect(() => {
    if (!watching || !pool) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const latest = await client.getBlockNumber();
        const fromBlock = lastSeenBlock ? lastSeenBlock + 1n : latest;
        if (fromBlock > latest) return;
        const logs = [];
        for (let start = fromBlock; start <= latest; start += 11n) {
          const end = start + 10n > latest ? latest : start + 10n;
          const chunk = await client.getLogs({
            address: INFINITY_ADDRESSES.clPoolManager,
            event: swapEvent,
            args: { id: pool.poolId },
            fromBlock: start,
            toBlock: end
          });
          logs.push(...chunk);
        }
        if (cancelled) return;
        setLastSeenBlock(latest);
        const last = logs[logs.length - 1];
        if (last?.args.sender && last.args.amount0 !== undefined && last.args.amount1 !== undefined) {
          setLastTrade({
            blockNumber: last.blockNumber,
            transactionHash: last.transactionHash,
            sender: last.args.sender,
            amount0: last.args.amount0,
            amount1: last.args.amount1,
            sqrtPriceX96: last.args.sqrtPriceX96 ?? pool.sqrtPriceX96,
            tick: last.args.tick ?? pool.tick
          });
        }
      } catch (error) {
        setStatus(`Ошибка monitor: ${(error as Error).message}`);
      }
    };
    const timer = window.setInterval(poll, 4_000);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [client, lastSeenBlock, pool, watching]);

  async function executeRebalanceDraft(position: PositionInfo) {
    if (!walletClient || !account || !pool || !helperAddress || !isAddress(helperAddress) || !lastTrade) return;
    const readable = readableTrade(lastTrade, pool.token0, pool.token1);
    if (!readable.inputToken || !readable.outputToken) {
      setStatus("Ошибка ребаланса: не удалось определить сторону swap-события.");
      return;
    }

    try {
      const liquidityToRemove = position.liquidity;
      const removed = getAmountsForLiquidity(
        pool.sqrtPriceX96,
        getSqrtRatioAtTick(position.tickLower),
        getSqrtRatioAtTick(position.tickUpper),
        liquidityToRemove
      );
      const { tickLower, tickUpper } = computeRange(pool, "both", 0);
      const price = sqrtPriceX96ToHumanPrice(
        pool.sqrtPriceX96,
        pool.token0.decimals,
        pool.token1.decimals
      );
      const inputIs0 =
        readable.inputToken.address.toLowerCase() === pool.token0.address.toLowerCase();
      const swapAmountIn = readable.inputAmount;
      const inputHuman = Number(formatUnits(swapAmountIn, readable.inputToken.decimals));
      const estimatedOutHuman = inputIs0 ? inputHuman * price : inputHuman / price;
      const estimatedOut = parseUnits(
        Math.max(0, estimatedOutHuman * 0.995).toFixed(readable.outputToken.decimals),
        readable.outputToken.decimals
      );

      let amount0After = removed.amount0;
      let amount1After = removed.amount1;
      if (inputIs0) {
        amount0After = amount0After > swapAmountIn ? amount0After - swapAmountIn : 0n;
        amount1After += estimatedOut;
      } else {
        amount1After = amount1After > swapAmountIn ? amount1After - swapAmountIn : 0n;
        amount0After += estimatedOut;
      }

      const safety = Math.min(100, Math.max(1, normalizePercent(rebalanceSafety, 90)));
      const mintLiquidity =
        (getLiquidityForAmounts(
          pool.sqrtPriceX96,
          getSqrtRatioAtTick(tickLower),
          getSqrtRatioAtTick(tickUpper),
          amount0After,
          amount1After
        ) *
          BigInt(Math.round(safety * 100))) /
        10_000n;

      const bps = Math.max(0, Math.floor(normalizePercent(slippageBps, 50)));
      const minOutput = parseAmount(rebalanceMinOut, readable.outputToken.decimals);
      setBusy(true);
      setStatus("Подтвердите черновой rebalance-транзакт в MetaMask...");
      const hash = await writeWithWallet(walletClient, {
        address: getAddress(helperAddress),
        abi: atomicExecutorAbi,
        functionName: "rebalance",
        args: [
          poolKeyToTuple(pool.poolKey),
          position.tokenId,
          liquidityToRemove,
          applySlippageDown(removed.amount0, bps),
          applySlippageDown(removed.amount1, bps),
          readable.inputToken.address,
          readable.outputToken.address,
          swapAmountIn,
          minOutput,
          tickLower,
          tickUpper,
          mintLiquidity,
          amount0After,
          amount1After,
          deadlineFromNow(DEADLINE_SECONDS)
        ],
        account
      });
      await client.waitForTransactionReceipt({ hash });
      await refreshPositionsAndApprovals();
    } catch (error) {
      setStatus(`Ошибка rebalance: ${(error as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const priceLabel = pool ? describePrice(pool) : "Пул ещё не загружен";
  const minRangePercent = pool ? (Math.pow(1.0001, Math.max(1, pool.tickSpacing)) - 1) * 100 : 0.01;
  const lastTradeReadable = pool && lastTrade ? readableTrade(lastTrade, pool.token0, pool.token1) : null;
  const token0Symbol = pool?.token0.symbol ?? "NES";
  const token1Symbol = pool?.token1.symbol ?? "USDT";
  const token0Label = `${token0Symbol} (token0)`;
  const token1Label = `${token1Symbol} (token1)`;

  return (
    <main className="app-shell">
      <section className="topbar">
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">
            <span />
          </div>
          <div>
            <div className="eyebrow">PancakeSwap Infinity v4</div>
            <h1>NES/USDT Liquidity</h1>
            <p>{priceLabel}</p>
          </div>
        </div>
        <div className="top-actions">
          <span className="network-pill">BNB Chain</span>
          <button className="primary wallet-button" onClick={connectWallet} disabled={busy}>
            <Wallet size={18} />
            {account ? `${account.slice(0, 6)}…${account.slice(-4)}` : "MetaMask"}
          </button>
        </div>
      </section>

      <section className={statusClass(status)}>
        <CircleDot size={16} />
        <span>{status}</span>
      </section>

      <section className="grid two">
        <div className="panel">
          <div className="panel-title">
            <PlugZap size={18} />
            <h2>Пул</h2>
          </div>
          <label>
            Pool ID
            <input value={poolId} onChange={(event) => setPoolId(event.target.value as Hex)} />
          </label>
          <div className="row">
            <label>
              RPC
              <input value={rpcUrl} onChange={(event) => setRpcUrl(event.target.value)} />
            </label>
            <label>
              Scan from block
              <input value={scanFromBlock} onChange={(event) => setScanFromBlock(event.target.value)} />
            </label>
          </div>
          <button className="primary wide" onClick={loadPool} disabled={busy}>
            <RefreshCcw size={18} />
            Загрузить пул
          </button>
          {pool && (
            <div className="facts">
              <span>Tick: {pool.tick}</span>
              <span>Tick spacing: {pool.tickSpacing}</span>
              <span>Min range: {formatCompact(minRangePercent, 5)}%</span>
              <span>LP fee: {pool.lpFee}</span>
              <span>
                {pool.token0.symbol}: {formatTokenAmount(pool.token0.balance, pool.token0.decimals)}
              </span>
              <span>
                {pool.token1.symbol}: {formatTokenAmount(pool.token1.balance, pool.token1.decimals)}
              </span>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-title">
            <ShieldCheck size={18} />
            <h2>Approve для добавления</h2>
          </div>
          {!pool && <p className="muted">Загрузите пул, чтобы увидеть токены.</p>}
          {pool &&
            [pool.token0, pool.token1].map((token) => {
              const approval = approvals[tokenKey(token.address, INFINITY_ADDRESSES.clPositionManager)];
              const ok = approval && approval.erc20Allowance > 0n && approval.permit2Allowance > 0n;
              return (
                <div className="approval" key={token.address}>
                  <div>
                    <strong>{token.symbol}</strong>
                    <span>{ok ? "Permit2 готов" : "Нужен approve"}</span>
                  </div>
                  <button onClick={() => approveForAdd(token.address)} disabled={!account || busy}>
                    <CheckCircle2 size={16} />
                    Approve
                  </button>
                </div>
              );
            })}
        </div>
      </section>

      <section className="panel panel-feature">
        <div className="panel-title">
          <ArrowDownUp size={18} />
          <h2>Добавить концентрированную ликвидность</h2>
        </div>
        <div className="segmented">
          <button className={mode === "both" ? "active" : ""} onClick={() => setMode("both")}>
            2 токена: {token0Symbol} + {token1Symbol}
          </button>
          <button className={mode === "token0" ? "active" : ""} onClick={() => setMode("token0")}>
            Только {token0Symbol}
          </button>
          <button className={mode === "token1" ? "active" : ""} onClick={() => setMode("token1")}>
            Только {token1Symbol}
          </button>
        </div>
        <div className="token-legend" aria-label="Соответствие токенов">
          <span>{token0Label}</span>
          <span>{token1Label}</span>
        </div>
        <div className="grid four">
          <label>
            Offset от текущей цены, %
            <input value={offsetPercent} onChange={(event) => setOffsetPercent(event.target.value)} />
          </label>
          <label>
            {token0Label}
            <input
              value={amount0}
              disabled={mode === "token1"}
              onChange={(event) => setAmount0(event.target.value)}
              placeholder="0.0"
            />
          </label>
          <label>
            {token1Label}
            <input
              value={amount1}
              disabled={mode === "token0"}
              onChange={(event) => setAmount1(event.target.value)}
              placeholder="0.0"
            />
          </label>
          <label>
            Slippage, bps
            <input value={slippageBps} onChange={(event) => setSlippageBps(event.target.value)} />
          </label>
        </div>
        {pool && preview && (
          <div className="preview">
            <span>
              Range: {preview.tickLower} → {preview.tickUpper}
            </span>
            <span>
              Prices: {formatCompact(priceAtTick(preview.tickLower, pool.token0.decimals, pool.token1.decimals))} →{" "}
              {formatCompact(priceAtTick(preview.tickUpper, pool.token0.decimals, pool.token1.decimals))}
            </span>
            <span>Liquidity: {preview.liquidity.toString()}</span>
          </div>
        )}
        <button className="primary wide" onClick={mintPosition} disabled={!pool || !account || !preview || busy}>
          Добавить ликвидность
        </button>
      </section>

      <section className="panel">
        <div className="panel-title">
          <Activity size={18} />
          <h2>Позиции</h2>
          <button onClick={scanPositionsFromLogs} disabled={!pool || !account || busy}>
            Найти позиции
          </button>
        </div>
        <div className="row">
          <label>
            NFT tokenId
            <input
              value={manualTokenId}
              onChange={(event) => setManualTokenId(event.target.value)}
              placeholder="Например 12345"
            />
          </label>
          <button onClick={addManualPosition} disabled={!pool || !account || !manualTokenId || busy}>
            Добавить tokenId
          </button>
        </div>
        <p className="muted">
          Если позиция не находится автоматически, вставьте её NFT tokenId вручную или поставьте Scan from block
          раньше блока, где позиция была создана.
        </p>
        <button onClick={scanPositionsFromLogs} disabled={!pool || !account || busy}>
          Полный поиск по Transfer-логам
        </button>
        {positions.length === 0 && <p className="muted">Позиции этого кошелька по текущему poolId не найдены.</p>}
        <div className="positions">
          {positions.map((position) => {
            const amounts = pool
              ? getAmountsForLiquidity(
                  pool.sqrtPriceX96,
                  getSqrtRatioAtTick(position.tickLower),
                  getSqrtRatioAtTick(position.tickUpper),
                  position.liquidity
                )
              : { amount0: 0n, amount1: 0n };
            return (
              <article className="position" key={position.tokenId.toString()}>
                <div>
                  <strong>#{position.tokenId.toString()}</strong>
                  <span>
                    {position.tickLower} → {position.tickUpper}
                  </span>
                  {pool && (
                    <span>
                      ~{formatTokenAmount(amounts.amount0, pool.token0.decimals, 4)} {pool.token0.symbol} /{" "}
                      {formatTokenAmount(amounts.amount1, pool.token1.decimals, 4)} {pool.token1.symbol}
                    </span>
                  )}
                </div>
                <label className="small">
                  %
                  <input
                    value={positionPercents[position.tokenId.toString()] ?? "100"}
                    onChange={(event) =>
                      setPositionPercents((prev) => ({
                        ...prev,
                        [position.tokenId.toString()]: event.target.value
                      }))
                    }
                  />
                </label>
                <button onClick={() => removePosition(position, false)} disabled={busy}>
                  Снять %
                </button>
                <button onClick={() => removePosition(position, true)} disabled={busy}>
                  Снять всё
                </button>
              </article>
            );
          })}
        </div>
      </section>

      <section className="panel panel-feature">
        <div className="panel-title">
          <RefreshCcw size={18} />
          <h2>Follow-price range</h2>
        </div>
        <p className="notice">
          Держит выбранную позицию в минимальном диапазоне на заданном проценте ниже или выше текущей цены.
        </p>
        <div className="segmented">
          <button
            className={followSide === "below" ? "active" : ""}
            onClick={() => setFollowSide("below")}
          >
            Ниже цены
          </button>
          <button
            className={followSide === "above" ? "active" : ""}
            onClick={() => setFollowSide("above")}
          >
            Выше цены
          </button>
          <button
            onClick={() => {
              setMode(followSide === "below" ? "token1" : "token0");
              setOffsetPercent(followSide === "below" ? `-${followOffsetPercent}` : followOffsetPercent);
            }}
            disabled={!pool}
          >
            Вставить в Add
          </button>
        </div>
        <div className="grid four">
          <label>
            Offset, %
            <input value={followOffsetPercent} onChange={(event) => setFollowOffsetPercent(event.target.value)} />
          </label>
          <label>
            Check, sec
            <input value={followCheckSeconds} onChange={(event) => setFollowCheckSeconds(event.target.value)} />
          </label>
          <label>
            Mint safety, %
            <input value={followSafety} onChange={(event) => setFollowSafety(event.target.value)} />
          </label>
          <label>
            Position
            <select value={selectedPositionId} onChange={(event) => setSelectedPositionId(event.target.value)}>
              {positions.map((position) => (
                <option key={position.tokenId.toString()} value={position.tokenId.toString()}>
                  #{position.tokenId.toString()}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          <label>
            Helper contract
            <input
              value={helperAddress}
              onChange={(event) => setHelperAddress(event.target.value)}
              placeholder="0x..."
            />
          </label>
          <button onClick={deployHelper} disabled={!account || busy}>
            Deploy helper
          </button>
        </div>
        {pool && followPreview && (
          <div className="preview">
            <span>
              Target: {followPreview.tickLower} → {followPreview.tickUpper}
            </span>
            <span>
              Prices: {formatCompact(priceAtTick(followPreview.tickLower, pool.token0.decimals, pool.token1.decimals))} →{" "}
              {formatCompact(priceAtTick(followPreview.tickUpper, pool.token0.decimals, pool.token1.decimals))}
            </span>
            <span>Asset: {followPreview.targetToken.symbol}</span>
            <span>{followPreview.needsMove ? "Move needed" : "On target"}</span>
            <span>{nftApprovalLabel}</span>
          </div>
        )}
        <div className="row">
          <button
            onClick={() => void approveAllNftsToHelper()}
            disabled={!account || currentNftOperatorApproved || busy}
          >
            {approveAllButtonLabel}
          </button>
          <button
            className="primary"
            onClick={() => currentPosition && executeFollowReposition(currentPosition)}
            disabled={!currentPosition || !pool || busy}
          >
            Переставить сейчас
          </button>
        </div>
        <div className="row">
          <button
            className={followWatching ? "danger" : "primary"}
            onClick={toggleFollowService}
            disabled={!currentPosition || !pool || busy}
          >
            {followWatching ? "Остановить сервис" : "Запустить сервис"}
          </button>
          <div className="service-state">{followLastCheck}</div>
        </div>
      </section>

      <section className="grid two">
        <div className="panel">
          <div className="panel-title">
            <ShieldCheck size={18} />
            <h2>Atomic exit + sell</h2>
          </div>
          <p className="notice">
            Работает одной транзакцией: снять ликвидность, продать выбранный токен через этот же пул и вернуть остатки.
          </p>
          {pool && (
            <div className="facts">
              <span>Pool: {pool.token0.symbol}/{pool.token1.symbol}</span>
              <span>Pool ID: {`${pool.poolId.slice(0, 10)}…${pool.poolId.slice(-6)}`}</span>
              <span>Price: {describePrice(pool)}</span>
            </div>
          )}
          <div className="row">
            <label>
              Helper contract
              <input
                value={helperAddress}
                onChange={(event) => setHelperAddress(event.target.value)}
                placeholder="0x..."
              />
            </label>
            <button onClick={deployHelper} disabled={!account || busy}>
              Deploy
            </button>
          </div>
          <div className="row">
            <label>
              Position
              <select value={selectedPositionId} onChange={(event) => setSelectedPositionId(event.target.value)}>
                {positions.map((position) => (
                  <option key={position.tokenId.toString()} value={position.tokenId.toString()}>
                    #{position.tokenId.toString()}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Exit %
              <input value={exitPercent} onChange={(event) => setExitPercent(event.target.value)} />
            </label>
          </div>
          {pool && (
            <div className="row">
              <label>
                Sell token
                <select value={sellCurrency} onChange={(event) => setSellCurrency(event.target.value as Address)}>
                  <option value={pool.token0.address}>{pool.token0.symbol}</option>
                  <option value={pool.token1.address}>{pool.token1.symbol}</option>
                </select>
              </label>
              <label>
                Min out
                <input value={minOut} onChange={(event) => setMinOut(event.target.value)} placeholder="0.0" />
              </label>
            </div>
          )}
          {pool && atomicPreview && (
            <div className="preview">
              <span>
                Sell: {atomicPreview.sellToken.symbol} → {atomicPreview.buyToken.symbol}
              </span>
              <span>
                Remove: {formatTokenAmount(atomicPreview.withdrawnAmount0, pool.token0.decimals, 4)}{" "}
                {pool.token0.symbol} / {formatTokenAmount(atomicPreview.withdrawnAmount1, pool.token1.decimals, 4)}{" "}
                {pool.token1.symbol}
              </span>
              <span>
                To sell: {formatTokenAmount(atomicPreview.sellAmount, atomicPreview.sellToken.decimals, 4)}{" "}
                {atomicPreview.sellToken.symbol}
              </span>
              <span>{nftApprovalLabel}</span>
              <span>
                {atomicPreview.sellAmount > 0n
                  ? "Готово к продаже"
                  : `В позиции нет ${atomicPreview.sellToken.symbol} для продажи`}
              </span>
            </div>
          )}
          <div className="row">
            <button
              onClick={() => void approveAllNftsToHelper()}
              disabled={!account || currentNftOperatorApproved || busy}
            >
              {approveAllButtonLabel}
            </button>
            <button
              className="primary"
              onClick={() => currentPosition && atomicExitAndSell(currentPosition)}
              disabled={
                !currentPosition ||
                !pool ||
                !atomicPreview ||
                atomicPreview.sellAmount <= 0n ||
                busy
              }
            >
              Снять и продать за {atomicPreview?.buyToken.symbol ?? "USDT"}
            </button>
          </div>
        </div>

        <div className="panel">
          <div className="panel-title">
            <RefreshCcw size={18} />
            <h2>Управление диапазоном</h2>
          </div>
          <div className="segmented">
            <button
              className={managedSide === "below" ? "active" : ""}
              onClick={() => setManagedSide("below")}
            >
              Ниже цены • USDT
            </button>
            <button
              className={managedSide === "above" ? "active" : ""}
              onClick={() => setManagedSide("above")}
            >
              Выше цены • NES
            </button>
          </div>
          <div className="grid four">
            <label>
              Отступ от цены, %
              <input value={managedOffsetPercent} onChange={(event) => setManagedOffsetPercent(event.target.value)} />
            </label>
            <label>
              Сумма {managedPreview?.targetToken.symbol ?? (managedSide === "below" ? "USDT" : "NES")}
              <input value={managedAmount} onChange={(event) => setManagedAmount(event.target.value)} placeholder="0.0" />
            </label>
            <label>
              Slippage, bps
              <input value={slippageBps} onChange={(event) => setSlippageBps(event.target.value)} />
            </label>
            <label>
              Position
              <select value={selectedPositionId} onChange={(event) => setSelectedPositionId(event.target.value)}>
                {positions.map((position) => (
                  <option key={position.tokenId.toString()} value={position.tokenId.toString()}>
                    #{position.tokenId.toString()}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <label>
              Helper contract для перестановки
              <input
                value={helperAddress}
                onChange={(event) => setHelperAddress(event.target.value)}
                placeholder="0x..."
              />
            </label>
            <button onClick={deployHelper} disabled={!account || busy}>
              Создать helper
            </button>
          </div>
          <div className="row">
            <label>
              Strategy contract для автономного бота
              <input
                value={strategyAddress}
                onChange={(event) => setStrategyAddress(event.target.value)}
                placeholder="0x..."
              />
            </label>
            <button
              onClick={transferPositionToStrategy}
              disabled={!currentPosition || !account || !strategyAddressValid || busy}
            >
              Передать NFT в strategy
            </button>
          </div>
          <div className="row">
            <label>
              Активный tokenId strategy
              <input
                value={strategyTokenId}
                onChange={(event) => setStrategyTokenId(event.target.value)}
                placeholder="Например 870803"
              />
            </label>
            <button onClick={findStrategyActivePosition} disabled={!pool || !strategyAddressValid || busy}>
              Найти active NFT
            </button>
            <button onClick={setStrategyCurrentTokenId} disabled={!account || !strategyAddressValid || !strategyTokenId || busy}>
              Сохранить tokenId
            </button>
          </div>
          <div className="row">
            <label>
              Куда вывести NFT из strategy
              <input
                value={strategyWithdrawTo}
                onChange={(event) => setStrategyWithdrawTo(event.target.value)}
                placeholder={account ?? "0x..."}
              />
            </label>
            <button onClick={withdrawStrategyCurrentPosition} disabled={!account || !strategyAddressValid || busy}>
              Вывести NFT из strategy
            </button>
          </div>
          <div className="preview">
            <span>{helperAddressValid ? "Helper готов" : "Нужен helper"}</span>
            <span>{currentPosition ? `Позиция #${currentPosition.tokenId.toString()}` : "Выберите позицию"}</span>
            <span>{nftApprovalLabel}</span>
            <span>{strategyAddressValid ? "Strategy готова" : "Strategy не указана"}</span>
            <span>{strategyTokenId ? `Strategy NFT #${strategyTokenId}` : "Strategy NFT не найдена"}</span>
            <span>Перестановка: 100%</span>
          </div>
          {pool && managedPreview && (
            <div className="preview">
              <span>
                Target: {managedPreview.tickLower} → {managedPreview.tickUpper}
              </span>
              <span>
                Prices: {formatCompact(priceAtTick(managedPreview.tickLower, pool.token0.decimals, pool.token1.decimals))} →{" "}
                {formatCompact(priceAtTick(managedPreview.tickUpper, pool.token0.decimals, pool.token1.decimals))}
              </span>
              <span>Asset: {managedPreview.targetToken.symbol}</span>
              <span>Liquidity: {managedPreview.liquidity.toString()}</span>
              <span>{managedTokenApprovalLabel}</span>
            </div>
          )}
          <div className="row">
            <button
              onClick={() => managedPreview && approveForAdd(managedPreview.targetToken.address)}
              disabled={!pool || !account || !managedPreview || managedPreview.amount <= 0n || managedTokenApproved || busy}
            >
              {managedApproveButtonLabel}
            </button>
            <button
              className="primary"
              onClick={mintManagedPosition}
              disabled={!pool || !account || !managedPreview || managedPreview.liquidity <= 0n || !managedTokenApproved || busy}
            >
              Добавить {managedPreview?.targetToken.symbol ?? "ликвидность"}
            </button>
          </div>
          <div className="position managed-position">
            <div>
              <strong>
                {currentPosition ? `Позиция #${currentPosition.tokenId.toString()}` : "Позиция не выбрана"}
              </strong>
              <span>
                Диапазон: {currentPosition ? `${currentPosition.tickLower} → ${currentPosition.tickUpper}` : "-"}
              </span>
              <span>
                Размер: {selectedPositionStats ? `~${formatCompact(selectedPositionStats.valueUsdt, 4)} USDT` : "-"}
              </span>
              {selectedPositionStats && pool ? (
                <span>
                  Активы: {formatTokenAmount(selectedPositionStats.amount0, pool.token0.decimals, 4)} {pool.token0.symbol} /{" "}
                  {formatTokenAmount(selectedPositionStats.amount1, pool.token1.decimals, 4)} {pool.token1.symbol}
                </span>
              ) : (
                <span>Активы: выберите или найдите NFT-позицию</span>
              )}
              <span>Доход/fees: точный расчёт при изъятии или collect</span>
            </div>
            <label className="small">
              Изъять, %
              <input value={managedWithdrawPercent} onChange={(event) => setManagedWithdrawPercent(event.target.value)} />
            </label>
            <button
              onClick={() => currentPosition && removePosition(currentPosition, false, managedWithdrawPercent)}
              disabled={!currentPosition || busy}
            >
              Изъять %
            </button>
            <button onClick={() => currentPosition && removePosition(currentPosition, true)} disabled={!currentPosition || busy}>
              Изъять всё
            </button>
          </div>
          <div className="row">
            <button
              onClick={() => void approveAllNftsToHelper()}
              disabled={!account || currentNftOperatorApproved || busy}
            >
              {approveAllButtonLabel}
            </button>
            <button
              className="primary"
              onClick={() =>
                currentPosition &&
                executeFollowReposition(currentPosition, pool, {
                  side: managedSide,
                  offsetPercent: managedOffsetPercent,
                  mintSafetyPercent: "100"
                })
              }
              disabled={!currentPosition || !pool || busy}
            >
              Переставить сейчас
            </button>
          </div>
          <div className="row">
            <button
              className={followWatching ? "danger" : "primary"}
              onClick={startManagedRangeService}
              disabled={!currentPosition || !pool || busy}
            >
              {followWatching ? "Остановить удержание" : "Держать диапазон"}
            </button>
            <div className="service-state">{followLastCheck}</div>
          </div>
          {lastTradeReadable?.inputToken && lastTradeReadable.outputToken && (
            <div className="preview">
              <span>Последний swap: block {lastTrade?.blockNumber.toString()}</span>
              <span>
                {formatTokenAmount(lastTradeReadable.inputAmount, lastTradeReadable.inputToken.decimals, 6)}{" "}
                {lastTradeReadable.inputToken.symbol} →{" "}
                {formatTokenAmount(lastTradeReadable.outputAmount, lastTradeReadable.outputToken.decimals, 6)}{" "}
                {lastTradeReadable.outputToken.symbol}
              </span>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
