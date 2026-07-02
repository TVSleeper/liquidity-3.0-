import type { Address, Hex } from "viem";

export const DEFAULT_POOL_ID =
  "0x1c0195a12979e395d956a9e2581ef720b925b2a7cc1c60a5b82d9fc0fc564ffa" as Hex;

export const BSC_CHAIN_ID = 56;
export const BSC_RPC_URL = "https://bsc-mainnet.public.blastapi.io";
export const DEFAULT_SCAN_FROM_BLOCK = 106_000_000n;

export const ZERO_ADDRESS =
  "0x0000000000000000000000000000000000000000" as Address;

export const INFINITY_ADDRESSES = {
  permit2: "0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768",
  vault: "0x238a358808379702088667322f80aC48bAd5e6c4",
  clPoolManager: "0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b",
  clPositionManager: "0x55f4c8abA71A1e923edC303eb4fEfF14608cC226",
  universalRouter: "0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB",
  clQuoter: "0xd0737C9762912dD34c3271197E362Aa736Df0926"
} as const satisfies Record<string, Address>;

export const ACTIONS = {
  CL_INCREASE_LIQUIDITY: 0x00,
  CL_DECREASE_LIQUIDITY: 0x01,
  CL_MINT_POSITION: 0x02,
  CL_BURN_POSITION: 0x03,
  CL_SWAP_EXACT_IN_SINGLE: 0x06,
  SETTLE: 0x0b,
  SETTLE_PAIR: 0x0d,
  TAKE: 0x0e,
  TAKE_PAIR: 0x11,
  CLOSE_CURRENCY: 0x12
} as const;

export const UNIVERSAL_COMMANDS = {
  INFI_SWAP: 0x10
} as const;

export const MAX_UINT160 = (1n << 160n) - 1n;
export const MAX_UINT256 = (1n << 256n) - 1n;
export const PERMIT2_MAX_EXPIRATION = 281_474_976_710_655;
export const DEADLINE_SECONDS = 20 * 60;
