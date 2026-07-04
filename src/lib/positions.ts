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

type PositionScanProgress = {
  fromBlock: bigint;
  toBlock: bigint;
  latestBlock: bigint;
  foundTokenIds: number;
};

const MAX_TRANSFER_LOG_BLOCKS = 5_000n;
const MIN_TRANSFER_LOG_BLOCKS = 50n;

function isNotMintedError(error: unknown): boolean {
  let current: unknown = error;
  for (let index = 0; index < 4 && current && typeof current === "object"; index += 1) {
    const entry = current as { message?: string; shortMessage?: string; details?: string; cause?: unknown };
    const message = `${entry.shortMessage ?? ""} ${entry.details ?? ""} ${entry.message ?? ""}`;
    if (message.includes("NOT_MINTED")) return true;
    current = entry.cause;
  }
  return false;
}

export async function readPositionById(args: {
  client: PublicClient;
  tokenId: bigint;
  poolId?: Hex;
  owner?: Address;
}): Promise<PositionInfo | null> {
  const actualOwner = await args.client
    .readContract({
      address: INFINITY_ADDRESSES.clPositionManager,
      abi: clPositionManagerAbi,
      functionName: "ownerOf",
      args: [args.tokenId]
    })
    .catch((error) => {
      if (isNotMintedError(error)) return null;
      throw error;
    });
  if (!actualOwner) return null;
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
  toBlock: bigint,
  onProgress?: (progress: PositionScanProgress) => void
): Promise<Set<bigint>> {
  const owned = new Set<bigint>();
  const ownerLower = getAddress(owner).toLowerCase();
  let chunkSize = MAX_TRANSFER_LOG_BLOCKS;
  let start = fromBlock;

  while (start <= toBlock) {
    const end = start + chunkSize - 1n > toBlock ? toBlock : start + chunkSize - 1n;

    try {
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

      const uniqueLogs = new Map<string, (typeof incoming)[number]>();
      for (const log of [...incoming, ...outgoing]) {
        uniqueLogs.set(`${log.transactionHash}-${log.logIndex}`, log);
      }

      const orderedLogs = [...uniqueLogs.values()].sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
        return a.logIndex - b.logIndex;
      });

      for (const log of orderedLogs) {
        const tokenId = log.args.id;
        if (tokenId === undefined || !log.args.from || !log.args.to) continue;

        const fromLower = getAddress(log.args.from).toLowerCase();
        const toLower = getAddress(log.args.to).toLowerCase();
        if (fromLower === ownerLower && toLower !== ownerLower) owned.delete(tokenId);
        if (toLower === ownerLower) owned.add(tokenId);
      }

      onProgress?.({
        fromBlock: start,
        toBlock: end,
        latestBlock: toBlock,
        foundTokenIds: owned.size
      });

      start = end + 1n;
      if (chunkSize < MAX_TRANSFER_LOG_BLOCKS) {
        chunkSize = chunkSize * 2n > MAX_TRANSFER_LOG_BLOCKS ? MAX_TRANSFER_LOG_BLOCKS : chunkSize * 2n;
      }
    } catch (error) {
      if (chunkSize <= MIN_TRANSFER_LOG_BLOCKS) throw error;
      chunkSize = chunkSize / 2n < MIN_TRANSFER_LOG_BLOCKS ? MIN_TRANSFER_LOG_BLOCKS : chunkSize / 2n;
    }
  }

  return owned;
}

export async function scanOwnedPositions(args: {
  client: PublicClient;
  owner: Address;
  poolId: Hex;
  fromBlock?: bigint;
  toBlock?: bigint;
  onProgress?: (progress: PositionScanProgress) => void;
}): Promise<PositionInfo[]> {
  const fromBlock = args.fromBlock ?? DEFAULT_SCAN_FROM_BLOCK;
  const latest = args.toBlock ?? await args.client.getBlockNumber();
  if (fromBlock > latest) {
    throw new Error(
      `Scan from block (${fromBlock.toString()}) больше текущего блока BNB Chain (${latest.toString()}). Установите меньший блок, например ${DEFAULT_SCAN_FROM_BLOCK.toString()}.`
    );
  }
  const tokenIds = await collectTransferTokenIds(
    args.client,
    args.owner,
    fromBlock,
    latest,
    args.onProgress
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
