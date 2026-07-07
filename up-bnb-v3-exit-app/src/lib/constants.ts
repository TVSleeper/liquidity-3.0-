import type { Address } from "viem";

export const BSC_CHAIN_ID = 56;
export const BSC_RPC_URL = "https://bsc-mainnet.public.blastapi.io";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
export const DEADLINE_SECONDS = 20 * 60;

export const PANCAKE_V3_ADDRESSES = {
  nonfungiblePositionManager: "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364",
  swapRouter: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
  wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"
} as const satisfies Record<string, Address>;

export const UP_BNB_V3_POOL = {
  pool: "0x57cf8c65fd1e2b44ea9e8f8ea0784ac6d0b60624",
  upToken: "0x000008d2175f9aeaddb2430c26f8a6f73c5a0000"
} as const satisfies Record<string, Address>;
