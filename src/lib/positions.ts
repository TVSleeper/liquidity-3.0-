import {
  getAddress,
  type Address,
  type Hex,
  type PublicClient
} from "viem";
import { clPositionManagerAbi, transferEvent } from "./abis";
import { DEFAULT_SCAN_FROM_BLOCK, INFINITY_ADDRESSES, ZERO_ADDRESS } from "./constants";
import { computePoolId, tupleToPoolKey } from "./encoding";
import type { PositionInfo } from "./types";

export async function readPositionById(args: {
  client: PublicClient;
  tokenId: bigint;
  poolId?: Hex;
  owner?: Address;
}): Promise<PositionInfo | null> {
  const actualOwner = await args.client.readContract({
    address: INFINITY_ADDRESSES.clPositionManager,
    abi: clPositionManagerAbi,
    functionName: "ownerOf",
    args: [args.tokenId]
  });
  if (args.owner && getAddress(actualOwner) !== getAddress(args.owner)) return null;

  const raw = await args.client.readContract({
    address: INFINITY_ADDRESSES.clPositionManager,
    abi: clPositionManagerAbi,
    functionName: "positions",
    args: [args.tokenId]
  });
  const [
    rawPoolKey,
    tickLower,
    tickUpper,
    liquidity,
    feeGrowthInside0LastX128,
    feeGrowthInside1LastX128
  ] = raw;
  const poolKey = tupleToPoolKey(rawPoolKey);
  if (args.poolId && computePoolId(poolKey).toLowerCase() !== args.poolId.toLowerCase()) {
    return null;
  }
  if (liquidity === 0n) return null;

  return {
    tokenId: args.tokenId,
    poolKey,
    tickLower,
    tickUpper,
    liquidity,
    feeGrowthInside0LastX128,
    feeGrowthInside1LastX128
  };
}

async function collectTransferTokenIds(
  client: PublicClient,
  owner: Address,
  fromBlock: bigint,
  toBlock: bigint
): Promise<Set<bigint>> {
  const owned = new Set<bigint>();
  const chunkSize = 10n;

  for (let start = fromBlock; start <= toBlock; start += chunkSize + 1n) {
    const end = start + chunkSize > toBlock ? toBlock : start + chunkSize;
    const [incoming, outgoing] = await Promise.all([
      client.getLogs({
        address: INFINITY_ADDRESSES.clPositionManager,
        event: transferEvent,
        args: { to: owner },
        fromBlock: start,
        toBlock: end
      }),
      client.getLogs({
        address: INFINITY_ADDRESSES.clPositionManager,
        event: transferEvent,
        args: { from: owner },
        fromBlock: start,
        toBlock: end
      })
    ]);

    for (const log of incoming) {
      if (log.args.id !== undefined) owned.add(log.args.id);
    }
    for (const log of outgoing) {
      if (log.args.id !== undefined) owned.delete(log.args.id);
    }
  }

  return owned;
}

export async function scanOwnedPositions(args: {
  client: PublicClient;
  owner: Address;
  poolId: Hex;
  fromBlock?: bigint;
}): Promise<PositionInfo[]> {
  const fromBlock = args.fromBlock ?? DEFAULT_SCAN_FROM_BLOCK;
  const latest = await args.client.getBlockNumber();
  const tokenIds = await collectTransferTokenIds(
    args.client,
    args.owner,
    fromBlock,
    latest
  );

  const positions: PositionInfo[] = [];
  for (const tokenId of tokenIds) {
    try {
      const actualOwner = await args.client.readContract({
        address: INFINITY_ADDRESSES.clPositionManager,
        abi: clPositionManagerAbi,
        functionName: "ownerOf",
        args: [tokenId]
      });
      if (getAddress(actualOwner) !== getAddress(args.owner)) continue;

      const raw = await args.client.readContract({
        address: INFINITY_ADDRESSES.clPositionManager,
        abi: clPositionManagerAbi,
        functionName: "positions",
        args: [tokenId]
      });
      const [
        rawPoolKey,
        tickLower,
        tickUpper,
        liquidity,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128
      ] = raw;
      const poolKey = tupleToPoolKey(rawPoolKey);
      if (computePoolId(poolKey).toLowerCase() !== args.poolId.toLowerCase()) continue;
      if (liquidity === 0n) continue;

      positions.push({
        tokenId,
        poolKey,
        tickLower,
        tickUpper,
        liquidity,
        feeGrowthInside0LastX128,
        feeGrowthInside1LastX128
      });
    } catch {
      continue;
    }
  }

  return positions.sort((a, b) => Number(a.tokenId - b.tokenId));
}

export function isBurnAddress(address: Address): boolean {
  return address.toLowerCase() === ZERO_ADDRESS.toLowerCase();
}
