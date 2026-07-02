import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  type Address,
  type Hex,
  type PublicClient
} from "viem";
import { bsc } from "viem/chains";
import { clPoolManagerAbi, erc20Abi, initializeEvent } from "./abis";
import {
  BSC_RPC_URL,
  DEFAULT_SCAN_FROM_BLOCK,
  INFINITY_ADDRESSES,
  ZERO_ADDRESS
} from "./constants";
import { decodeTickSpacing, sqrtPriceX96ToHumanPrice } from "./math";
import type { PoolKey, PoolState, TokenInfo } from "./types";

export function createBscClient(rpcUrl = BSC_RPC_URL): PublicClient {
  return createPublicClient({
    chain: bsc,
    transport: http(rpcUrl)
  });
}

export async function readTokenInfo(
  client: PublicClient,
  token: Address,
  owner?: Address
): Promise<TokenInfo> {
  const [name, symbol, decimals, balance] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "name" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    owner
      ? client.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [owner]
        })
      : Promise.resolve(0n)
  ]);

  return {
    address: getAddress(token),
    name,
    symbol,
    decimals,
    balance
  };
}

export async function discoverPoolKey(
  client: PublicClient,
  poolId: Hex,
  fromBlock = DEFAULT_SCAN_FROM_BLOCK
): Promise<PoolKey> {
  const direct = await client.readContract({
    address: INFINITY_ADDRESSES.clPoolManager,
    abi: clPoolManagerAbi,
    functionName: "poolIdToPoolKey",
    args: [poolId]
  });

  if (direct[3].toLowerCase() !== ZERO_ADDRESS.toLowerCase()) {
    return {
      currency0: getAddress(direct[0]),
      currency1: getAddress(direct[1]),
      hooks: getAddress(direct[2]),
      poolManager: getAddress(direct[3]),
      fee: Number(direct[4]),
      parameters: direct[5]
    };
  }

  const latest = await client.getBlockNumber();
  const chunkSize = 10n;
  const logs = [];

  for (let start = fromBlock; start <= latest; start += chunkSize + 1n) {
    const end = start + chunkSize > latest ? latest : start + chunkSize;
    const chunk = await client.getLogs({
      address: INFINITY_ADDRESSES.clPoolManager,
      event: initializeEvent,
      args: { id: poolId },
      fromBlock: start,
      toBlock: end
    });
    logs.push(...chunk);
    if (logs.length > 0) break;
  }

  if (logs.length === 0) {
    throw new Error(
      `PoolKey не найден в Initialize-логах с блока ${fromBlock.toString()}. Уменьшите стартовый блок или проверьте RPC.`
    );
  }

  const event = logs[logs.length - 1].args;
  if (!event.currency0 || !event.currency1 || !event.hooks || !event.parameters) {
    throw new Error("RPC вернул неполный Initialize-log для этого poolId");
  }

  return {
    currency0: getAddress(event.currency0),
    currency1: getAddress(event.currency1),
    hooks: getAddress(event.hooks),
    poolManager: INFINITY_ADDRESSES.clPoolManager,
    fee: Number(event.fee),
    parameters: event.parameters
  };
}

export async function loadPoolState(
  client: PublicClient,
  poolId: Hex,
  poolKey: PoolKey,
  owner?: Address
): Promise<PoolState> {
  const [[sqrtPriceX96, tick, protocolFee, lpFee], liquidity, token0, token1] =
    await Promise.all([
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

export function describePrice(pool: PoolState): string {
  const price = sqrtPriceX96ToHumanPrice(
    pool.sqrtPriceX96,
    pool.token0.decimals,
    pool.token1.decimals
  );
  return `1 ${pool.token0.symbol} = ${price.toLocaleString("en-US", {
    maximumFractionDigits: 10,
    useGrouping: false
  })} ${pool.token1.symbol}`;
}

export function tokenValueLabel(token: TokenInfo, amount: bigint): string {
  return `${formatUnits(amount, token.decimals)} ${token.symbol}`;
}
