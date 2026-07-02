import type { Address, Hex } from "viem";

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  hooks: Address;
  poolManager: Address;
  fee: number;
  parameters: Hex;
};

export type TokenInfo = {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  balance: bigint;
};

export type PoolState = {
  poolId: Hex;
  poolKey: PoolKey;
  sqrtPriceX96: bigint;
  tick: number;
  protocolFee: number;
  lpFee: number;
  tickSpacing: number;
  liquidity: bigint;
  token0: TokenInfo;
  token1: TokenInfo;
};

export type PositionInfo = {
  tokenId: bigint;
  poolKey: PoolKey;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  feeGrowthInside0LastX128: bigint;
  feeGrowthInside1LastX128: bigint;
};

export type TradeEvent = {
  blockNumber: bigint;
  transactionHash: Hex;
  sender: Address;
  amount0: bigint;
  amount1: bigint;
  tick: number;
  sqrtPriceX96: bigint;
};

