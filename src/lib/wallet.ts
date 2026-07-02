import type { WalletClient } from "viem";

export async function writeWithWallet(
  walletClient: WalletClient,
  params: unknown
): Promise<`0x${string}`> {
  return (walletClient as WalletClient & {
    writeContract: (value: unknown) => Promise<`0x${string}`>;
  }).writeContract(params);
}

export async function deployWithWallet(
  walletClient: WalletClient,
  params: unknown
): Promise<`0x${string}`> {
  return (walletClient as WalletClient & {
    deployContract: (value: unknown) => Promise<`0x${string}`>;
  }).deployContract(params);
}

