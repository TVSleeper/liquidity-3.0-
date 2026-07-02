import {
  encodeAbiParameters,
  formatUnits,
  keccak256,
  parseAbiParameters,
  type Address,
  type Hex
} from "viem";
import { ACTIONS } from "./constants";
import type { PoolKey } from "./types";

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
} as const;

export function poolKeyToTuple(poolKey: PoolKey) {
  return {
    currency0: poolKey.currency0,
    currency1: poolKey.currency1,
    hooks: poolKey.hooks,
    poolManager: poolKey.poolManager,
    fee: poolKey.fee,
    parameters: poolKey.parameters
  };
}

export function tupleToPoolKey(value: unknown): PoolKey {
  if (Array.isArray(value)) {
    return {
      currency0: value[0] as Address,
      currency1: value[1] as Address,
      hooks: value[2] as Address,
      poolManager: value[3] as Address,
      fee: Number(value[4]),
      parameters: value[5] as Hex
    };
  }
  const entry = value as PoolKey;
  return {
    currency0: entry.currency0,
    currency1: entry.currency1,
    hooks: entry.hooks,
    poolManager: entry.poolManager,
    fee: Number(entry.fee),
    parameters: entry.parameters
  };
}

export function computePoolId(poolKey: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters([poolKeyAbi], [poolKeyToTuple(poolKey)])
  );
}

export function buildPlan(actions: number[], params: Hex[]): Hex {
  const packedActions = `0x${actions
    .map((action) => action.toString(16).padStart(2, "0"))
    .join("")}` as Hex;
  return encodeAbiParameters(
    parseAbiParameters("bytes actions, bytes[] params"),
    [packedActions, params]
  );
}

export function buildMintPayload(args: {
  poolKey: PoolKey;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  amount0Max: bigint;
  amount1Max: bigint;
  owner: Address;
}): Hex {
  const mintParam = encodeAbiParameters(
    [
      poolKeyAbi,
      { type: "int24" },
      { type: "int24" },
      { type: "uint256" },
      { type: "uint128" },
      { type: "uint128" },
      { type: "address" },
      { type: "bytes" }
    ],
    [
      poolKeyToTuple(args.poolKey),
      args.tickLower,
      args.tickUpper,
      args.liquidity,
      args.amount0Max,
      args.amount1Max,
      args.owner,
      "0x"
    ]
  );
  const close0 = encodeAbiParameters([{ type: "address" }], [args.poolKey.currency0]);
  const close1 = encodeAbiParameters([{ type: "address" }], [args.poolKey.currency1]);
  return buildPlan(
    [ACTIONS.CL_MINT_POSITION, ACTIONS.CLOSE_CURRENCY, ACTIONS.CLOSE_CURRENCY],
    [mintParam, close0, close1]
  );
}

export function buildDecreasePayload(args: {
  poolKey: PoolKey;
  tokenId: bigint;
  liquidity: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  recipient: Address;
}): Hex {
  const decreaseParam = encodeAbiParameters(
    [
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint128" },
      { type: "uint128" },
      { type: "bytes" }
    ],
    [args.tokenId, args.liquidity, args.amount0Min, args.amount1Min, "0x"]
  );
  const takePair = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }],
    [args.poolKey.currency0, args.poolKey.currency1, args.recipient]
  );
  return buildPlan([ACTIONS.CL_DECREASE_LIQUIDITY, ACTIONS.TAKE_PAIR], [
    decreaseParam,
    takePair
  ]);
}

export function buildBurnPayload(args: {
  poolKey: PoolKey;
  tokenId: bigint;
  amount0Min: bigint;
  amount1Min: bigint;
  recipient: Address;
}): Hex {
  const burnParam = encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }],
    [args.tokenId, args.amount0Min, args.amount1Min, "0x"]
  );
  const takePair = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }],
    [args.poolKey.currency0, args.poolKey.currency1, args.recipient]
  );
  return buildPlan([ACTIONS.CL_BURN_POSITION, ACTIONS.TAKE_PAIR], [
    burnParam,
    takePair
  ]);
}

export function formatTokenAmount(amount: bigint, decimals: number, digits = 6): string {
  const value = Number(formatUnits(amount, decimals));
  if (!Number.isFinite(value)) return formatUnits(amount, decimals);
  return value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    useGrouping: false
  });
}

export function deadlineFromNow(seconds: number): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + seconds);
}
