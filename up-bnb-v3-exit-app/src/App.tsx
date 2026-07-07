import { CheckCircle2, Loader2, RefreshCcw, ShieldCheck, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  http,
  isAddress,
  parseUnits,
  type Address,
  type Hex,
  type WalletClient
} from "viem";
import { bsc } from "viem/chains";
import { pancakeV3ExitSellerBytecode, pancakeV3ExitSellerCompiledAbi } from "./generated/PancakeV3ExitSeller";
import { erc20Abi, pancakeV3PoolAbi, pancakeV3PositionManagerAbi } from "./lib/abis";
import {
  BSC_CHAIN_ID,
  BSC_RPC_URL,
  DEADLINE_SECONDS,
  PANCAKE_V3_ADDRESSES,
  UP_BNB_V3_POOL,
  ZERO_ADDRESS
} from "./lib/constants";
import { deployWithWallet, writeWithWallet } from "./lib/wallet";

type TokenMeta = {
  address: Address;
  symbol: string;
  decimals: number;
};

type V3PoolInfo = {
  token0: TokenMeta;
  token1: TokenMeta;
  fee: number;
};

type V3PositionInfo = {
  tokenId: bigint;
  owner: Address;
  token0: Address;
  token1: Address;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  tokensOwed0: bigint;
  tokensOwed1: bigint;
  approved: boolean;
  approvedForAll: boolean;
};

function assertSuccessfulReceipt(
  receipt: { status?: "success" | "reverted"; transactionHash?: Hex },
  fallbackHash: Hex,
  label: string
) {
  if (receipt.status !== "success") {
    throw new Error(`${label} откатилась. Tx: ${receipt.transactionHash ?? fallbackHash}`);
  }
}

function compactErrorMessage(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let index = 0; index < 4 && current && typeof current === "object"; index += 1) {
    const entry = current as {
      shortMessage?: string;
      details?: string;
      message?: string;
      cause?: unknown;
    };
    const message = entry.shortMessage ?? entry.details ?? entry.message;
    if (message && !messages.includes(message)) messages.push(message);
    current = entry.cause;
  }
  return (messages[0] ?? String(error)).replace(/\s+/g, " ").slice(0, 700);
}

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

  function setStoredValue(next: T) {
    localStorage.setItem(key, JSON.stringify(next));
    setValue(next);
  }

  return [value, setStoredValue] as const;
}

function sameAddress(a: Address | string, b: Address | string) {
  return a.toLowerCase() === b.toLowerCase();
}

function shortAddress(address: Address | string) {
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function parseTokenId(value: string): bigint | null {
  const clean = value.trim();
  if (!/^\d+$/.test(clean)) return null;
  return BigInt(clean);
}

function normalizePercent(value: string, fallback: number): number {
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pctToLiquidity(liquidity: bigint, percentText: string) {
  const percent = Math.min(100, Math.max(0, normalizePercent(percentText, 100)));
  return (liquidity * BigInt(Math.round(percent * 100))) / 10_000n;
}

function parseAmount(value: string, decimals: number): bigint {
  const clean = value.trim().replace(",", ".");
  if (!clean) return 0n;
  return parseUnits(clean, decimals);
}

function formatTokenAmount(value: bigint, decimals: number, digits = 4) {
  const raw = formatUnits(value, decimals);
  const num = Number(raw);
  if (!Number.isFinite(num)) return raw;
  return num.toLocaleString("en-US", {
    maximumFractionDigits: digits
  });
}

function deadlineFromNow(seconds: number) {
  return BigInt(Math.floor(Date.now() / 1000) + seconds);
}

function statusClass(message: string) {
  if (message.toLowerCase().includes("ошибка")) return "status error";
  if (message.toLowerCase().includes("готово")) return "status ok";
  return "status";
}

export function App() {
  const [account, setAccount] = useState<Address | null>(null);
  const [walletClient, setWalletClient] = useState<WalletClient | null>(null);
  const [helperAddress, setHelperAddress] = useStoredState("upBnbV3ExitHelperAddress", "");
  const [tokenId, setTokenId] = useStoredState("upBnbV3ExitTokenId", "");
  const [exitPercent, setExitPercent] = useState("100");
  const [minBnbOut, setMinBnbOut] = useState("0");
  const [poolInfo, setPoolInfo] = useState<V3PoolInfo | null>(null);
  const [position, setPosition] = useState<V3PositionInfo | null>(null);
  const [positions, setPositions] = useState<V3PositionInfo[]>([]);
  const [status, setStatus] = useState("Готов к подключению MetaMask.");
  const [busy, setBusy] = useState(false);

  const client = useMemo(
    () =>
      createPublicClient({
        chain: bsc,
        transport: http(BSC_RPC_URL)
      }),
    []
  );

  const normalizedHelperAddress = helperAddress && isAddress(helperAddress) ? getAddress(helperAddress) : null;
  const tokenIdValue = parseTokenId(tokenId);
  const isOwner = Boolean(account && position && sameAddress(account, position.owner));
  const isUpBnbPosition = Boolean(
    position &&
      ((sameAddress(position.token0, UP_BNB_V3_POOL.upToken) &&
        sameAddress(position.token1, PANCAKE_V3_ADDRESSES.wbnb)) ||
        (sameAddress(position.token0, PANCAKE_V3_ADDRESSES.wbnb) &&
          sameAddress(position.token1, UP_BNB_V3_POOL.upToken)))
  );
  const nftApproved = Boolean(position && (position.approved || position.approvedForAll));
  const liquidityToRemove = position ? pctToLiquidity(position.liquidity, exitPercent) : 0n;
  const upIsToken0 = position ? sameAddress(position.token0, UP_BNB_V3_POOL.upToken) : true;
  const upFees = position ? (upIsToken0 ? position.tokensOwed0 : position.tokensOwed1) : 0n;
  const wbnbFees = position ? (upIsToken0 ? position.tokensOwed1 : position.tokensOwed0) : 0n;
  const upMeta = poolInfo
    ? sameAddress(poolInfo.token0.address, UP_BNB_V3_POOL.upToken)
      ? poolInfo.token0
      : poolInfo.token1
    : { address: UP_BNB_V3_POOL.upToken, symbol: "UP", decimals: 18 };

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
      setStatus("Ошибка: MetaMask не найден.");
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
      const nextAccount = getAddress(connected);
      setAccount(nextAccount);
      setWalletClient(wc);
      setStatus("Кошелек подключен.");
      void scanOwnedPositions(nextAccount, false);
    } catch (error) {
      setStatus(`Ошибка подключения: ${compactErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function readTokenMeta(address: Address, fallbackSymbol: string): Promise<TokenMeta> {
    const [symbol, decimals] = await Promise.all([
      client
        .readContract({
          address,
          abi: erc20Abi,
          functionName: "symbol"
        })
        .catch(() => fallbackSymbol),
      client
        .readContract({
          address,
          abi: erc20Abi,
          functionName: "decimals"
        })
        .catch(() => 18)
    ]);
    return {
      address,
      symbol,
      decimals: Number(decimals)
    };
  }

  async function readPoolInfo(): Promise<V3PoolInfo> {
    const [token0, token1, fee] = await Promise.all([
      client.readContract({
        address: UP_BNB_V3_POOL.pool,
        abi: pancakeV3PoolAbi,
        functionName: "token0"
      }),
      client.readContract({
        address: UP_BNB_V3_POOL.pool,
        abi: pancakeV3PoolAbi,
        functionName: "token1"
      }),
      client.readContract({
        address: UP_BNB_V3_POOL.pool,
        abi: pancakeV3PoolAbi,
        functionName: "fee"
      })
    ]);

    const [meta0, meta1] = await Promise.all([
      readTokenMeta(getAddress(token0), sameAddress(token0, UP_BNB_V3_POOL.upToken) ? "UP" : "WBNB"),
      readTokenMeta(getAddress(token1), sameAddress(token1, UP_BNB_V3_POOL.upToken) ? "UP" : "WBNB")
    ]);

    return {
      token0: meta0,
      token1: meta1,
      fee: Number(fee)
    };
  }

  async function readPosition(nextTokenId: bigint, helper: Address | null = normalizedHelperAddress) {
    const [owner, rawPosition] = await Promise.all([
      client.readContract({
        address: PANCAKE_V3_ADDRESSES.nonfungiblePositionManager,
        abi: pancakeV3PositionManagerAbi,
        functionName: "ownerOf",
        args: [nextTokenId]
      }),
      client.readContract({
        address: PANCAKE_V3_ADDRESSES.nonfungiblePositionManager,
        abi: pancakeV3PositionManagerAbi,
        functionName: "positions",
        args: [nextTokenId]
      })
    ]);
    const [, , token0, token1, fee, tickLower, tickUpper, liquidity, , , tokensOwed0, tokensOwed1] =
      rawPosition;
    const normalizedOwner = getAddress(owner);
    const [approved, approvedForAll] =
      helper && account
        ? await Promise.all([
            client
              .readContract({
                address: PANCAKE_V3_ADDRESSES.nonfungiblePositionManager,
                abi: pancakeV3PositionManagerAbi,
                functionName: "getApproved",
                args: [nextTokenId]
              })
              .catch(() => ZERO_ADDRESS),
            client
              .readContract({
                address: PANCAKE_V3_ADDRESSES.nonfungiblePositionManager,
                abi: pancakeV3PositionManagerAbi,
                functionName: "isApprovedForAll",
                args: [normalizedOwner, helper]
              })
              .catch(() => false)
          ])
        : [ZERO_ADDRESS, false];

    return {
      tokenId: nextTokenId,
      owner: normalizedOwner,
      token0: getAddress(token0),
      token1: getAddress(token1),
      fee: Number(fee),
      tickLower: Number(tickLower),
      tickUpper: Number(tickUpper),
      liquidity,
      tokensOwed0,
      tokensOwed1,
      approved: helper ? sameAddress(getAddress(approved), helper) : false,
      approvedForAll: Boolean(approvedForAll)
    };
  }

  function isUpBnbV3Position(nextPosition: V3PositionInfo) {
    return (
      (sameAddress(nextPosition.token0, UP_BNB_V3_POOL.upToken) &&
        sameAddress(nextPosition.token1, PANCAKE_V3_ADDRESSES.wbnb)) ||
      (sameAddress(nextPosition.token0, PANCAKE_V3_ADDRESSES.wbnb) &&
        sameAddress(nextPosition.token1, UP_BNB_V3_POOL.upToken))
    );
  }

  async function scanOwnedPositions(ownerOverride?: Address, showDone = true) {
    const owner = ownerOverride ?? account;
    if (!owner) {
      setStatus("Ошибка поиска: сначала подключите MetaMask.");
      return;
    }

    try {
      setBusy(true);
      setStatus("Ищу открытые UP/BNB V3 позиции кошелька...");
      const nftBalance = await client.readContract({
        address: PANCAKE_V3_ADDRESSES.nonfungiblePositionManager,
        abi: pancakeV3PositionManagerAbi,
        functionName: "balanceOf",
        args: [owner]
      });
      const candidates: bigint[] = [];

      for (let index = 0n; index < nftBalance; index += 1n) {
        setStatus(`Проверяю V3 NFT кошелька: ${index + 1n} из ${nftBalance.toString()}...`);
        const nextTokenId = await client.readContract({
          address: PANCAKE_V3_ADDRESSES.nonfungiblePositionManager,
          abi: pancakeV3PositionManagerAbi,
          functionName: "tokenOfOwnerByIndex",
          args: [owner, index]
        });
        candidates.push(nextTokenId);
      }

      candidates.sort((a, b) => Number(b - a));
      const found: V3PositionInfo[] = [];

      for (const candidate of candidates) {
        const nextPosition = await readPosition(candidate).catch(() => null);
        if (!nextPosition) continue;
        if (!sameAddress(nextPosition.owner, owner)) continue;
        if (!isUpBnbV3Position(nextPosition)) continue;
        if (nextPosition.liquidity <= 0n) continue;
        found.push(nextPosition);
      }

      found.sort((a, b) => Number(b.tokenId - a.tokenId));
      setPositions(found);

      if (found[0]) {
        setTokenId(found[0].tokenId.toString());
        setPosition(found[0]);
        if (!poolInfo) setPoolInfo(await readPoolInfo());
        setStatus(
          showDone
            ? `Готово: найдено ${found.length} открытых UP/BNB V3 позиций. Выбрана #${found[0].tokenId.toString()}.`
            : `Кошелек подключен. Найдено ${found.length} UP/BNB V3 позиций.`
        );
      } else {
        setPosition(null);
        setStatus("Открытые UP/BNB V3 позиции на этом кошельке не найдены. Можно вставить tokenId вручную.");
      }
    } catch (error) {
      setStatus(`Ошибка поиска позиций: ${compactErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function loadPosition() {
    if (!tokenIdValue) {
      setStatus("Ошибка: укажите числовой V3 NFT tokenId.");
      return;
    }
    try {
      setBusy(true);
      setStatus("Обновляю UP/BNB V3 позицию...");
      const [nextPoolInfo, nextPosition] = await Promise.all([readPoolInfo(), readPosition(tokenIdValue)]);
      setPoolInfo(nextPoolInfo);
      setPosition(nextPosition);
      setPositions((prev) => {
        const rest = prev.filter((item) => item.tokenId !== nextPosition.tokenId);
        return [nextPosition, ...rest].sort((a, b) => Number(b.tokenId - a.tokenId));
      });
      const valid =
        (sameAddress(nextPosition.token0, UP_BNB_V3_POOL.upToken) &&
          sameAddress(nextPosition.token1, PANCAKE_V3_ADDRESSES.wbnb)) ||
        (sameAddress(nextPosition.token0, PANCAKE_V3_ADDRESSES.wbnb) &&
          sameAddress(nextPosition.token1, UP_BNB_V3_POOL.upToken));
      if (!valid) throw new Error("Эта NFT не относится к UP/BNB V3 pool.");
      setStatus(`Готово: позиция #${nextTokenLabel(nextPosition.tokenId)} загружена.`);
    } catch (error) {
      setStatus(`Ошибка обновления: ${compactErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  function nextTokenLabel(value: bigint) {
    return value.toString();
  }

  async function deployHelper(): Promise<Address | null> {
    if (!walletClient || !account) {
      setStatus("Ошибка deploy: сначала подключите MetaMask.");
      return null;
    }
    try {
      if (pancakeV3ExitSellerBytecode === "0x") {
        throw new Error("Контракт не скомпилирован. Запустите npm run compile:contracts.");
      }
      setBusy(true);
      setStatus("Подтвердите создание V3 helper...");
      const hash = await deployWithWallet(walletClient, {
        abi: pancakeV3ExitSellerCompiledAbi,
        bytecode: pancakeV3ExitSellerBytecode,
        args: [
          PANCAKE_V3_ADDRESSES.nonfungiblePositionManager,
          PANCAKE_V3_ADDRESSES.swapRouter,
          UP_BNB_V3_POOL.upToken,
          PANCAKE_V3_ADDRESSES.wbnb
        ],
        account
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      assertSuccessfulReceipt(receipt, hash, "Deploy helper");
      if (!receipt.contractAddress) throw new Error("Контракт не вернул адрес.");
      setHelperAddress(receipt.contractAddress);
      setStatus(`Готово: helper создан ${receipt.contractAddress}.`);
      return receipt.contractAddress;
    } catch (error) {
      setStatus(`Ошибка deploy: ${compactErrorMessage(error)}`);
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function approveNft(helperOverride?: Address, tokenIdOverride?: bigint): Promise<boolean> {
    const helper = helperOverride ?? normalizedHelperAddress;
    const activeTokenId = tokenIdOverride ?? tokenIdValue;
    if (!walletClient || !account) {
      setStatus("Ошибка approve: сначала подключите MetaMask.");
      return false;
    }
    if (!helper || !activeTokenId) {
      setStatus("Ошибка approve: укажите helper и V3 NFT tokenId.");
      return false;
    }
    try {
      setBusy(true);
      setStatus(`Подтвердите approve V3 NFT #${activeTokenId.toString()}...`);
      const hash = await writeWithWallet(walletClient, {
        address: PANCAKE_V3_ADDRESSES.nonfungiblePositionManager,
        abi: pancakeV3PositionManagerAbi,
        functionName: "approve",
        args: [helper, activeTokenId],
        account
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      assertSuccessfulReceipt(receipt, hash, "Approve V3 NFT");
      const updated = await readPosition(activeTokenId, helper);
      setPosition(updated);
      setPositions((prev) => prev.map((item) => (item.tokenId === updated.tokenId ? updated : item)));
      setStatus("Готово: V3 NFT разрешена для helper.");
      return true;
    } catch (error) {
      setStatus(`Ошибка approve: ${compactErrorMessage(error)}`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function exitAndSell() {
    if (!walletClient || !account) {
      setStatus("Ошибка exit: сначала подключите MetaMask.");
      return;
    }
    const helper = normalizedHelperAddress ?? (await deployHelper());
    if (!helper || !tokenIdValue) {
      setStatus("Ошибка exit: укажите helper и V3 NFT tokenId.");
      return;
    }

    try {
      setStatus("Обновляю позицию перед транзакцией...");
      const freshPosition = await readPosition(tokenIdValue, helper);
      setPosition(freshPosition);
      if (!sameAddress(freshPosition.owner, account)) {
        throw new Error(`NFT принадлежит ${shortAddress(freshPosition.owner)}, а не подключенному кошельку.`);
      }
      const valid =
        (sameAddress(freshPosition.token0, UP_BNB_V3_POOL.upToken) &&
          sameAddress(freshPosition.token1, PANCAKE_V3_ADDRESSES.wbnb)) ||
        (sameAddress(freshPosition.token0, PANCAKE_V3_ADDRESSES.wbnb) &&
          sameAddress(freshPosition.token1, UP_BNB_V3_POOL.upToken));
      if (!valid) throw new Error("Эта NFT не относится к UP/BNB V3 pool.");

      if (!freshPosition.approved && !freshPosition.approvedForAll) {
        const approved = await approveNft(helper, tokenIdValue);
        if (!approved) throw new Error("NFT approve не подтвержден.");
      }

      const updatedPosition = await readPosition(tokenIdValue, helper);
      const activeLiquidity = pctToLiquidity(updatedPosition.liquidity, exitPercent);
      if (activeLiquidity <= 0n) throw new Error("В выбранном проценте нет liquidity для снятия.");
      const minimumBnb = parseAmount(minBnbOut, 18);
      const deadline = deadlineFromNow(DEADLINE_SECONDS);
      const args = [tokenIdValue, activeLiquidity, 0n, 0n, minimumBnb, deadline] as const;

      setBusy(true);
      setStatus("Проверяю транзакцию перед MetaMask...");
      try {
        await client.simulateContract({
          address: helper,
          abi: pancakeV3ExitSellerCompiledAbi,
          functionName: "exitSellUpForBnb",
          args,
          account
        });
      } catch (error) {
        throw new Error(`Предварительная проверка показала revert: ${compactErrorMessage(error)}`);
      }

      setStatus("Подтвердите снятие liquidity и продажу UP за BNB...");
      const hash = await writeWithWallet(walletClient, {
        address: helper,
        abi: pancakeV3ExitSellerCompiledAbi,
        functionName: "exitSellUpForBnb",
        args,
        account
      });
      setStatus(`Транзакция отправлена: ${hash}. Жду подтверждение...`);
      const receipt = await client.waitForTransactionReceipt({ hash });
      assertSuccessfulReceipt(receipt, hash, "UP/BNB V3 exit + sell");
      const nextPosition = await readPosition(tokenIdValue, helper).catch(() => null);
      setPosition(nextPosition);
      setPositions((prev) => {
        const rest = prev.filter((item) => item.tokenId !== tokenIdValue);
        if (nextPosition && nextPosition.liquidity > 0n) return [nextPosition, ...rest];
        return rest;
      });
      setStatus(`Готово: liquidity снята, UP продан за BNB. Tx: ${hash}`);
    } catch (error) {
      setStatus(`Ошибка exit: ${compactErrorMessage(error)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <span className="eyebrow">PancakeSwap V3</span>
          <h1>UP/BNB Exit</h1>
          <p>1 транзакция: снять ликвидность, продать UP, получить BNB.</p>
        </div>
        <button className="wallet" onClick={connectWallet} disabled={busy}>
          <Wallet size={18} />
          {account ? shortAddress(account) : "MetaMask"}
        </button>
      </header>

      <div className={statusClass(status)}>
        {busy ? <Loader2 size={16} className="spin" /> : <CheckCircle2 size={16} />}
        {status}
      </div>

      <section className="panel">
        <div className="panel-title">
          <ShieldCheck size={18} />
          <h2>UP/BNB V3 exit + sell</h2>
        </div>

        <div className="facts">
          <span>Pool: {shortAddress(UP_BNB_V3_POOL.pool)}</span>
          <span>UP: {shortAddress(UP_BNB_V3_POOL.upToken)}</span>
          <span>WBNB: {shortAddress(PANCAKE_V3_ADDRESSES.wbnb)}</span>
          <span>NFT manager: {shortAddress(PANCAKE_V3_ADDRESSES.nonfungiblePositionManager)}</span>
          {poolInfo && (
            <>
              <span>Fee: {poolInfo.fee}</span>
              <span>
                Pair: {poolInfo.token0.symbol}/{poolInfo.token1.symbol}
              </span>
            </>
          )}
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
          <button onClick={() => void deployHelper()} disabled={!account || busy}>
            Deploy helper
          </button>
        </div>

        <div className="row">
          <label>
            Найденные открытые позиции
            <select
              value={tokenId}
              onChange={(event) => {
                const nextTokenId = event.target.value;
                setTokenId(nextTokenId);
                const selected = positions.find((item) => item.tokenId.toString() === nextTokenId) ?? null;
                setPosition(selected);
              }}
            >
              <option value="">
                {positions.length > 0 ? "Выберите позицию" : "Позиции ещё не найдены"}
              </option>
              {positions.map((item) => (
                <option key={item.tokenId.toString()} value={item.tokenId.toString()}>
                  #{item.tokenId.toString()} - liquidity {item.liquidity.toString()}
                </option>
              ))}
            </select>
          </label>
          <button onClick={() => void scanOwnedPositions()} disabled={!account || busy}>
            Найти позиции
          </button>
        </div>

        <div className="grid four">
          <label>
            V3 NFT tokenId вручную
            <input value={tokenId} onChange={(event) => setTokenId(event.target.value)} placeholder="Например 12345" />
          </label>
          <label>
            Exit %
            <input value={exitPercent} onChange={(event) => setExitPercent(event.target.value)} />
          </label>
          <label>
            Min BNB out
            <input value={minBnbOut} onChange={(event) => setMinBnbOut(event.target.value)} />
          </label>
          <button onClick={() => void loadPosition()} disabled={!account || !tokenIdValue || busy}>
            Загрузить NFT
          </button>
        </div>

        {position && (
          <div className="position">
            <div>
              <strong>Позиция #{position.tokenId.toString()}</strong>
              <span>Owner: {shortAddress(position.owner)}</span>
              <span>
                Диапазон: {position.tickLower} {"->"} {position.tickUpper}
              </span>
            </div>
            <div>
              <span>Liquidity: {position.liquidity.toString()}</span>
              <span>Снять liquidity: {liquidityToRemove.toString()}</span>
              <span>
                Fees: {formatTokenAmount(upFees, upMeta.decimals, 4)} {upMeta.symbol}
              </span>
              <span>Fees: {formatTokenAmount(wbnbFees, 18, 6)} WBNB</span>
            </div>
          </div>
        )}

        <div className="preview">
          <span>{isUpBnbPosition ? "UP/BNB pool готов" : "Выберите UP/BNB NFT"}</span>
          <span>{isOwner ? "Кошелек владелец NFT" : "Подключите кошелек-владелец"}</span>
          <span>{nftApproved ? "NFT approve готов" : "Нужен NFT approve"}</span>
          <span>{normalizedHelperAddress ? "Helper готов" : "Нужен helper"}</span>
        </div>

        <div className="row">
          <button
            onClick={() => void approveNft()}
            disabled={!account || !normalizedHelperAddress || !tokenIdValue || nftApproved || busy}
          >
            {nftApproved ? "NFT approve готов" : "Approve V3 NFT"}
          </button>
          <button
            className="primary"
            onClick={() => void exitAndSell()}
            disabled={!account || !position || !isUpBnbPosition || !isOwner || liquidityToRemove <= 0n || busy}
          >
            Снять и продать UP за BNB
          </button>
        </div>
      </section>

      <section className="panel compact">
        <div className="panel-title">
          <RefreshCcw size={18} />
          <h2>Адреса</h2>
        </div>
        <div className="addresses">
          <span>Position Manager</span>
          <code>{PANCAKE_V3_ADDRESSES.nonfungiblePositionManager}</code>
          <span>Swap Router</span>
          <code>{PANCAKE_V3_ADDRESSES.swapRouter}</code>
          <span>Pool</span>
          <code>{UP_BNB_V3_POOL.pool}</code>
        </div>
      </section>
    </main>
  );
}
