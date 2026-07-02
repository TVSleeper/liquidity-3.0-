import type { Address, PublicClient, WalletClient } from "viem";
import { erc20Abi, permit2Abi } from "./abis";
import {
  INFINITY_ADDRESSES,
  MAX_UINT160,
  MAX_UINT256,
  PERMIT2_MAX_EXPIRATION
} from "./constants";
import { writeWithWallet } from "./wallet";

export type ApprovalState = {
  erc20Allowance: bigint;
  permit2Allowance: bigint;
  permit2Expiration: bigint;
};

export async function readApprovalState(args: {
  client: PublicClient;
  owner: Address;
  token: Address;
  spender: Address;
}): Promise<ApprovalState> {
  const [erc20Allowance, permit2] = await Promise.all([
    args.client.readContract({
      address: args.token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [args.owner, INFINITY_ADDRESSES.permit2]
    }),
    args.client.readContract({
      address: INFINITY_ADDRESSES.permit2,
      abi: permit2Abi,
      functionName: "allowance",
      args: [args.owner, args.token, args.spender]
    })
  ]);

  return {
    erc20Allowance,
    permit2Allowance: permit2[0],
    permit2Expiration: BigInt(permit2[1])
  };
}

export async function approveTokenToPermit2(args: {
  walletClient: WalletClient;
  account: Address;
  token: Address;
}) {
  return writeWithWallet(args.walletClient, {
    address: args.token,
    abi: erc20Abi,
    functionName: "approve",
    args: [INFINITY_ADDRESSES.permit2, MAX_UINT256],
    account: args.account
  });
}

export async function approvePermit2Spender(args: {
  walletClient: WalletClient;
  account: Address;
  token: Address;
  spender: Address;
}) {
  return writeWithWallet(args.walletClient, {
    address: INFINITY_ADDRESSES.permit2,
    abi: permit2Abi,
    functionName: "approve",
    args: [args.token, args.spender, MAX_UINT160, PERMIT2_MAX_EXPIRATION],
    account: args.account
  });
}
