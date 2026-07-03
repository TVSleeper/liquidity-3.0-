import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseAbi,
  parseAbiParameters,
  parseUnits
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";

export const ROOT_DIR = path.resolve(new URL("..", import.meta.url).pathname);

export const DEFAULT_POOL_ID =
  "0x1c0195a12979e395d956a9e2581ef720b925b2a7cc1c60a5b82d9fc0fc564ffa";
export const DEFAULT_RPC_URL = "https://bsc-mainnet.public.blastapi.io";
export const DEFAULT_SCAN_FROM_BLOCK = 48_000_000n;
export const DEADLINE_SECONDS = 20 * 60;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export const INFINITY_ADDRESSES = {
  permit2: "0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768",
  clPoolManager: "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b",
  clPositionManager: "0x55f4c8abA71A1e923edC303eb4fEfF14608cC226",
  universalRouter: "0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB"
};

export const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)"
]);

export const clPoolManagerAbi = parseAbi([
  "function poolIdToPoolKey(bytes32 id) view returns (address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters)",
  "function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 id) view returns (uint128 liquidity)"
]);

export const clPositionManagerAbi = parseAbi([
  "function ownerOf(uint256 id) view returns (address)",
  "function positions(uint256 tokenId) view returns ((address currency0,address currency1,address hooks,address poolManager,uint24 fee,bytes32 parameters) poolKey,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,address subscriber)",
  "function safeTransferFrom(address from, address to, uint256 id)"
]);

export const strategyAbi = parseAbi([
  "constructor(address owner,address keeper,address positionManager,address executor,bytes32 poolId,int24 maxTickWidth)",
  "function currentTokenId() view returns (uint256)",
  "function keeper() view returns (address)",
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function poolId() view returns (bytes32)",
  "function rebalance((address currency0,address currency1,address hooks,address poolManager,uint24 fee,bytes32 parameters) poolKey,uint256 tokenId,uint128 liquidityToRemove,uint128 amount0Min,uint128 amount1Min,address swapInput,address swapOutput,uint128 swapAmountIn,uint128 swapAmountOutMin,int24 tickLower,int24 tickUpper,uint256 mintLiquidity,uint128 amount0Max,uint128 amount1Max,uint256 deadline)"
]);

export const poolKeyAbi = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "hooks", type: "address" },
    { name: "poolManager", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "parameters", type: "bytes32" }
  ]
};

export function loadDotEnv() {
  for (const file of [path.join(ROOT_DIR, ".env"), path.join(ROOT_DIR, "bot", ".env")]) {
    if (!fs.existsSync(file)) continue;
    for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const index = line.indexOf("=");
      if (index === -1) continue;
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

export function envString(name, fallback = undefined) {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing env ${name}`);
  }
  return value;
}

export function envNumber(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value.replace(",", "."));
  if (!Number.isFinite(parsed)) throw new Error(`Invalid numeric env ${name}`);
  return parsed;
}

export function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "y"].includes(value.toLowerCase());
}

export function envBigInt(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return BigInt(value.replaceAll("_", ""));
}

export function createClients() {
  loadDotEnv();
  const privateKey = envString("BOT_PRIVATE_KEY");
  const rpcUrl = envString("RPC_URL", DEFAULT_RPC_URL);
  const account = privateKeyToAccount(privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`);
  const publicClient = createPublicClient({ chain: bsc, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain: bsc, transport: http(rpcUrl) });
  return { account, publicClient, walletClient, rpcUrl };
}

export function loadArtifact(name) {
  const file = path.join(ROOT_DIR, "bot", "generated", `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Artifact ${name} not found. Run npm run compile:contracts first.`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function normalizePercent(value, fallback) {
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function deadlineFromNow(seconds = DEADLINE_SECONDS) {
  return BigInt(Math.floor(Date.now() / 1000) + seconds);
}

export function tupleToPoolKey(value) {
  return {
    currency0: getAddress(value[0] ?? value.currency0),
    currency1: getAddress(value[1] ?? value.currency1),
    hooks: getAddress(value[2] ?? value.hooks),
    poolManager: getAddress(value[3] ?? value.poolManager),
    fee: Number(value[4] ?? value.fee),
    parameters: value[5] ?? value.parameters
  };
}

export function poolKeyToTuple(poolKey) {
  return {
    currency0: poolKey.currency0,
    currency1: poolKey.currency1,
    hooks: poolKey.hooks,
    poolManager: poolKey.poolManager,
    fee: poolKey.fee,
    parameters: poolKey.parameters
  };
}

export function computePoolId(poolKey) {
  return keccak256(encodeAbiParameters([poolKeyAbi], [poolKeyToTuple(poolKey)]));
}

export async function discoverPoolKey(client, poolId) {
  const direct = await client.readContract({
    address: INFINITY_ADDRESSES.clPoolManager,
    abi: clPoolManagerAbi,
    functionName: "poolIdToPoolKey",
    args: [poolId]
  });
  const poolKey = tupleToPoolKey(direct);
  if (poolKey.poolManager.toLowerCase() === ZERO_ADDRESS.toLowerCase()) {
    throw new Error("PoolKey not found by poolIdToPoolKey. Use the UI once or add log discovery.");
  }
  return poolKey;
}

export async function readTokenInfo(client, token, owner) {
  const [symbol, decimals, balance] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    owner
      ? client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] })
      : Promise.resolve(0n)
  ]);
  return { address: getAddress(token), symbol, decimals, balance };
}

export async function loadPoolState(client, poolId, poolKey, owner) {
  const [[sqrtPriceX96, tick, protocolFee, lpFee], liquidity, token0, token1] = await Promise.all([
    client.readContract({
      address: INFINITY_ADDRESSES.clPoolManager,
      abi: clPoolManagerAbi,
      functionName: "getSlot0",
      args: [poolId]
    }),
    client.readContract({
      address: INFINITY_ADDRESSES.clPoolManager,
      abi: clPoolManagerAbi,
      functionName: "getLiquidity",
      args: [poolId]
    }),
    readTokenInfo(client, poolKey.currency0, owner),
    readTokenInfo(client, poolKey.currency1, owner)
  ]);
  return {
    poolId,
    poolKey,
    sqrtPriceX96,
    tick,
    protocolFee,
    lpFee,
    tickSpacing: decodeTickSpacing(poolKey.parameters),
    liquidity,
    token0,
    token1
  };
}

export async function readPositionById(client, tokenId, poolId, owner) {
  const actualOwner = await client.readContract({
    address: INFINITY_ADDRESSES.clPositionManager,
    abi: clPositionManagerAbi,
    functionName: "ownerOf",
    args: [tokenId]
  });
  if (owner && getAddress(actualOwner) !== getAddress(owner)) {
    throw new Error(`Position #${tokenId.toString()} is not owned by ${owner}`);
  }
  const raw = await client.readContract({
    address: INFINITY_ADDRESSES.clPositionManager,
    abi: clPositionManagerAbi,
    functionName: "positions",
    args: [tokenId]
  });
  const [rawPoolKey, tickLower, tickUpper, liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128] = raw;
  const poolKey = tupleToPoolKey(rawPoolKey);
  if (poolId && computePoolId(poolKey).toLowerCase() !== poolId.toLowerCase()) {
    throw new Error(`Position #${tokenId.toString()} belongs to another pool`);
  }
  if (liquidity === 0n) throw new Error(`Position #${tokenId.toString()} has zero liquidity`);
  return { tokenId, poolKey, tickLower, tickUpper, liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128 };
}

export function decodeTickSpacing(parameters) {
  return Number((BigInt(parameters) >> 16n) & 0xffffffn);
}

export function floorUsableTick(tick, tickSpacing) {
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

export function ceilUsableTick(tick, tickSpacing) {
  return Math.ceil(tick / tickSpacing) * tickSpacing;
}

export function offsetPercentToTicks(percent) {
  if (!Number.isFinite(percent) || percent === 0) return 0;
  return Math.round(Math.log1p(percent / 100) / Math.log(1.0001));
}

export function computeRange(pool, mode, offsetPercent) {
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

export function computeFollowRange(pool, side, offsetPercent) {
  const offset = Math.abs(offsetPercent);
  return side === "below"
    ? computeRange(pool, "token1", -offset)
    : computeRange(pool, "token0", offset);
}

export const Q96 = 1n << 96n;
export const Q32 = 1n << 32n;
const MAX_UINT256 = (1n << 256n) - 1n;

export function getSqrtRatioAtTick(tick) {
  const absTick = tick < 0 ? -tick : tick;
  let ratio =
    (absTick & 0x1) !== 0
      ? 0xfffcb933bd6fad37aa2d162d1a594001n
      : 0x100000000000000000000000000000000n;
  if ((absTick & 0x2) !== 0) ratio = (ratio * 0xfff97272373d413259a46990580e213an) >> 128n;
  if ((absTick & 0x4) !== 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn) >> 128n;
  if ((absTick & 0x8) !== 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n) >> 128n;
  if ((absTick & 0x10) !== 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644n) >> 128n;
  if ((absTick & 0x20) !== 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0n) >> 128n;
  if ((absTick & 0x40) !== 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861n) >> 128n;
  if ((absTick & 0x80) !== 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053n) >> 128n;
  if ((absTick & 0x100) !== 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n) >> 128n;
  if ((absTick & 0x200) !== 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54n) >> 128n;
  if ((absTick & 0x400) !== 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3n) >> 128n;
  if ((absTick & 0x800) !== 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n) >> 128n;
  if ((absTick & 0x1000) !== 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n) >> 128n;
  if ((absTick & 0x2000) !== 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n) >> 128n;
  if ((absTick & 0x4000) !== 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7n) >> 128n;
  if ((absTick & 0x8000) !== 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6n) >> 128n;
  if ((absTick & 0x10000) !== 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n) >> 128n;
  if ((absTick & 0x20000) !== 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604n) >> 128n;
  if ((absTick & 0x40000) !== 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98n) >> 128n;
  if ((absTick & 0x80000) !== 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2n) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % Q32 === 0n ? 0n : 1n);
}

export function mulDiv(a, b, denominator) {
  return (a * b) / denominator;
}

export function getLiquidityForAmount0(sqrtRatioAX96, sqrtRatioBX96, amount0) {
  let sqrtA = sqrtRatioAX96;
  let sqrtB = sqrtRatioBX96;
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  const intermediate = mulDiv(sqrtA, sqrtB, Q96);
  return mulDiv(amount0, intermediate, sqrtB - sqrtA);
}

export function getLiquidityForAmount1(sqrtRatioAX96, sqrtRatioBX96, amount1) {
  let sqrtA = sqrtRatioAX96;
  let sqrtB = sqrtRatioBX96;
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return mulDiv(amount1, Q96, sqrtB - sqrtA);
}

export function getLiquidityForAmounts(sqrtRatioX96, sqrtRatioAX96, sqrtRatioBX96, amount0, amount1) {
  let sqrtA = sqrtRatioAX96;
  let sqrtB = sqrtRatioBX96;
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtRatioX96 <= sqrtA) return getLiquidityForAmount0(sqrtA, sqrtB, amount0);
  if (sqrtRatioX96 < sqrtB) {
    const liquidity0 = getLiquidityForAmount0(sqrtRatioX96, sqrtB, amount0);
    const liquidity1 = getLiquidityForAmount1(sqrtA, sqrtRatioX96, amount1);
    return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
  }
  return getLiquidityForAmount1(sqrtA, sqrtB, amount1);
}

export function getAmount0ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity) {
  let sqrtA = sqrtRatioAX96;
  let sqrtB = sqrtRatioBX96;
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return mulDiv(liquidity << 96n, sqrtB - sqrtA, sqrtB) / sqrtA;
}

export function getAmount1ForLiquidity(sqrtRatioAX96, sqrtRatioBX96, liquidity) {
  let sqrtA = sqrtRatioAX96;
  let sqrtB = sqrtRatioBX96;
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return mulDiv(liquidity, sqrtB - sqrtA, Q96);
}

export function getAmountsForLiquidity(sqrtRatioX96, sqrtRatioAX96, sqrtRatioBX96, liquidity) {
  let sqrtA = sqrtRatioAX96;
  let sqrtB = sqrtRatioBX96;
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtRatioX96 <= sqrtA) return { amount0: getAmount0ForLiquidity(sqrtA, sqrtB, liquidity), amount1: 0n };
  if (sqrtRatioX96 < sqrtB) {
    return {
      amount0: getAmount0ForLiquidity(sqrtRatioX96, sqrtB, liquidity),
      amount1: getAmount1ForLiquidity(sqrtA, sqrtRatioX96, liquidity)
    };
  }
  return { amount0: 0n, amount1: getAmount1ForLiquidity(sqrtA, sqrtB, liquidity) };
}

export function applySlippageDown(amount, bps) {
  return (amount * BigInt(10_000 - bps)) / 10_000n;
}

export function applySlippageUp(amount, bps) {
  if (amount === 0n) return 0n;
  return (amount * BigInt(10_000 + bps) + 9_999n) / 10_000n;
}

export function sqrtPriceX96ToHumanPrice(sqrtPriceX96, decimals0, decimals1) {
  const raw = Number(sqrtPriceX96) / 2 ** 96;
  return raw * raw * 10 ** (decimals0 - decimals1);
}

export function tokenAmount(amount, decimals, digits = 6) {
  const value = Number(formatUnits(amount, decimals));
  if (!Number.isFinite(value)) return formatUnits(amount, decimals);
  return value.toLocaleString("en-US", { maximumFractionDigits: digits, useGrouping: false });
}

export function toUnits(value, decimals) {
  return parseUnits(String(value), decimals);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
