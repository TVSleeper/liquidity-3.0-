import { formatGwei, getAddress } from "viem";
import {
  DEFAULT_POOL_ID,
  applySlippageDown,
  applySlippageUp,
  clPositionManagerAbi,
  computeFollowRange,
  createClients,
  deadlineFromNow,
  discoverPoolKey,
  envBigInt,
  envBoolean,
  envNumber,
  envString,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  INFINITY_ADDRESSES,
  loadPoolState,
  poolKeyToTuple,
  readPositionById,
  sleep,
  sqrtPriceX96ToHumanPrice,
  strategyAbi,
  tokenAmount,
  toUnits
} from "./shared.mjs";

const { account, publicClient, walletClient } = createClients();

const strategyAddress = getAddress(envString("STRATEGY_ADDRESS"));
const poolId = envString("POOL_ID", DEFAULT_POOL_ID);
const side = envString("SIDE", "below");
const offsetPercent = envNumber("OFFSET_PERCENT", 0.2);
const checkSeconds = Math.max(1, envNumber("CHECK_SECONDS", 3));
const slippageBps = Math.max(0, Math.floor(envNumber("SLIPPAGE_BPS", 50)));
const mintSafetyPercent = Math.min(100, Math.max(1, envNumber("MINT_SAFETY_PERCENT", 100)));
const mintMaxBufferBps = Math.max(0, Math.floor(envNumber("MINT_MAX_BUFFER_BPS", 5)));
const rebalanceTickThreshold = Math.max(1, envNumber("REBALANCE_TICK_THRESHOLD", 0));
const maxGasGwei = envNumber("MAX_GAS_GWEI", 0);
const dryRun = envBoolean("DRY_RUN", true);
const once = envBoolean("RUN_ONCE", false);
const deadlineSeconds = Math.max(60, envNumber("DEADLINE_SECONDS", 20 * 60));
const minLiquidity = envBigInt("MIN_LIQUIDITY", 1n);
const recoveryScanLimit = Math.max(10, Math.floor(envNumber("RECOVERY_SCAN_LIMIT", 500)));

if (!["below", "above"].includes(side)) {
  throw new Error('SIDE must be "below" or "above"');
}

const poolKey = await discoverPoolKey(publicClient, poolId);

console.log("Autonomous range bot started");
console.log(`Keeper:   ${account.address}`);
console.log(`Strategy: ${strategyAddress}`);
console.log(`Pool:     ${poolId}`);
console.log(`Mode:     ${side}, offset ${offsetPercent}%, check ${checkSeconds}s`);
console.log(`Safety:   mint ${mintSafetyPercent}%, slippage ${slippageBps} bps`);
console.log(`Mint max: +${mintMaxBufferBps} bps buffer`);
console.log(`Dry run:  ${dryRun ? "yes" : "no"}`);
console.log("");

async function getStrategyTokenId() {
  const tokenId = await publicClient.readContract({
    address: strategyAddress,
    abi: strategyAbi,
    functionName: "currentTokenId"
  });
  if (tokenId === 0n) {
    throw new Error("Strategy has no currentTokenId. Transfer the LP NFT to the strategy first.");
  }
  return tokenId;
}

async function checkGas() {
  if (!maxGasGwei || maxGasGwei <= 0) return true;
  const gasPrice = await publicClient.getGasPrice();
  const current = Number(formatGwei(gasPrice));
  if (current > maxGasGwei) {
    console.log(`Gas ${current.toFixed(3)} gwei > MAX_GAS_GWEI ${maxGasGwei}; skip`);
    return false;
  }
  return true;
}

async function findLatestActiveStrategyPosition(staleTokenId) {
  const nextTokenId = await publicClient.readContract({
    address: INFINITY_ADDRESSES.clPositionManager,
    abi: clPositionManagerAbi,
    functionName: "nextTokenId"
  });
  if (nextTokenId <= 1n) return null;

  const start = nextTokenId - 1n;
  const limit = BigInt(recoveryScanLimit);
  const seen = new Set();
  const candidates = [];

  if (staleTokenId && staleTokenId + 1n < nextTokenId) {
    const forwardStop = staleTokenId + limit < start ? staleTokenId + limit : start;
    for (let tokenId = staleTokenId + 1n; tokenId <= forwardStop; tokenId += 1n) {
      candidates.push(tokenId);
      seen.add(tokenId.toString());
    }
  }

  const backwardStop = start > limit ? start - limit : 1n;
  for (let tokenId = start; tokenId >= backwardStop; tokenId -= 1n) {
    if (seen.has(tokenId.toString())) continue;
    candidates.push(tokenId);
    seen.add(tokenId.toString());
  }

  for (let index = 0; index < candidates.length; index += 100) {
    const batch = candidates.slice(index, index + 100);
    const owners = await publicClient.multicall({
      allowFailure: true,
      contracts: batch.map((tokenId) => ({
        address: INFINITY_ADDRESSES.clPositionManager,
        abi: clPositionManagerAbi,
        functionName: "ownerOf",
        args: [tokenId]
      }))
    });

    for (let ownerIndex = 0; ownerIndex < owners.length; ownerIndex += 1) {
      const owner = owners[ownerIndex];
      if (owner.status !== "success") continue;
      if (getAddress(owner.result) !== strategyAddress) continue;
      const tokenId = batch[ownerIndex];
      try {
        return await readPositionById(publicClient, tokenId, poolId, strategyAddress);
      } catch {
        // The strategy can hold old empty NFTs after rebalances; skip them.
      }
    }
  }
  return null;
}

async function buildRebalance() {
  const strategyPaused = await publicClient.readContract({
    address: strategyAddress,
    abi: strategyAbi,
    functionName: "paused"
  });
  if (strategyPaused) throw new Error("Strategy is paused");

  const tokenId = await getStrategyTokenId();
  const pool = await loadPoolState(publicClient, poolId, poolKey, strategyAddress);
  let position;
  try {
    position = await readPositionById(publicClient, tokenId, poolId, strategyAddress);
  } catch (error) {
    const active = await findLatestActiveStrategyPosition(tokenId);
    if (active && active.tokenId !== tokenId) {
      return {
        shouldMove: false,
        reason: `strategy currentTokenId #${tokenId.toString()} is stale or empty. Active strategy NFT appears to be #${active.tokenId.toString()}. In the app: click "Найти active NFT", then "Сохранить tokenId" with owner wallet.`
      };
    }
    throw error;
  }
  const target = computeFollowRange(pool, side, offsetPercent);
  const threshold = rebalanceTickThreshold || Math.max(1, pool.tickSpacing);
  const drift = Math.max(
    Math.abs(position.tickLower - target.tickLower),
    Math.abs(position.tickUpper - target.tickUpper)
  );

  if (drift < threshold) {
    return {
      shouldMove: false,
      reason: `on target: position ${position.tickLower}->${position.tickUpper}, target ${target.tickLower}->${target.tickUpper}, tick ${pool.tick}`
    };
  }

  if (position.liquidity < minLiquidity) {
    return {
      shouldMove: false,
      reason: `liquidity ${position.liquidity.toString()} < MIN_LIQUIDITY ${minLiquidity.toString()}`
    };
  }

  const removed = getAmountsForLiquidity(
    pool.sqrtPriceX96,
    getSqrtRatioAtTick(position.tickLower),
    getSqrtRatioAtTick(position.tickUpper),
    position.liquidity
  );
  const price = sqrtPriceX96ToHumanPrice(
    pool.sqrtPriceX96,
    pool.token0.decimals,
    pool.token1.decimals
  );

  let swapInput = pool.token0.address;
  let swapOutput = pool.token1.address;
  let swapAmountIn = 0n;
  let swapAmountOutMin = 0n;
  let amount0After = removed.amount0;
  let amount1After = removed.amount1;

  if (side === "below" && removed.amount0 > 0n) {
    swapInput = pool.token0.address;
    swapOutput = pool.token1.address;
    swapAmountIn = removed.amount0;
    const estimatedOutHuman = Number(tokenAmount(removed.amount0, pool.token0.decimals, 18)) * price;
    swapAmountOutMin = toUnits(
      Math.max(0, estimatedOutHuman * (1 - slippageBps / 10_000)).toFixed(pool.token1.decimals),
      pool.token1.decimals
    );
    amount0After = 0n;
    amount1After += swapAmountOutMin;
  }

  if (side === "above" && removed.amount1 > 0n) {
    swapInput = pool.token1.address;
    swapOutput = pool.token0.address;
    swapAmountIn = removed.amount1;
    const estimatedOutHuman = Number(tokenAmount(removed.amount1, pool.token1.decimals, 18)) / price;
    swapAmountOutMin = toUnits(
      Math.max(0, estimatedOutHuman * (1 - slippageBps / 10_000)).toFixed(pool.token0.decimals),
      pool.token0.decimals
    );
    amount1After = 0n;
    amount0After += swapAmountOutMin;
  }

  const mintLiquidity =
    (getLiquidityForAmounts(
      pool.sqrtPriceX96,
      getSqrtRatioAtTick(target.tickLower),
      getSqrtRatioAtTick(target.tickUpper),
      amount0After,
      amount1After
    ) *
      BigInt(Math.round(mintSafetyPercent * 100))) /
    10_000n;

  if (mintLiquidity <= 0n) {
    return { shouldMove: false, reason: "calculated mint liquidity is zero" };
  }

  return {
    shouldMove: true,
    pool,
    position,
    target,
    args: [
      poolKeyToTuple(pool.poolKey),
      position.tokenId,
      position.liquidity,
      applySlippageDown(removed.amount0, slippageBps),
      applySlippageDown(removed.amount1, slippageBps),
      swapInput,
      swapOutput,
      swapAmountIn,
      swapAmountOutMin,
      target.tickLower,
      target.tickUpper,
      mintLiquidity,
      applySlippageUp(amount0After, mintMaxBufferBps),
      applySlippageUp(amount1After, mintMaxBufferBps),
      deadlineFromNow(deadlineSeconds)
    ],
    summary: {
      removed,
      swapInput,
      swapOutput,
      swapAmountIn,
      swapAmountOutMin,
      mintLiquidity
    }
  };
}

async function tick() {
  try {
    const plan = await buildRebalance();
    const stamp = new Date().toISOString();
    if (!plan.shouldMove) {
      console.log(`[${stamp}] ${plan.reason}`);
      return;
    }

    console.log(
      `[${stamp}] rebalance #${plan.position.tokenId.toString()}: ${plan.position.tickLower}->${plan.position.tickUpper} to ${plan.target.tickLower}->${plan.target.tickUpper}`
    );
    console.log(
      `  remove ${tokenAmount(plan.summary.removed.amount0, plan.pool.token0.decimals)} ${plan.pool.token0.symbol} / ${tokenAmount(plan.summary.removed.amount1, plan.pool.token1.decimals)} ${plan.pool.token1.symbol}`
    );
    if (plan.summary.swapAmountIn > 0n) {
      const inputToken =
        plan.summary.swapInput.toLowerCase() === plan.pool.token0.address.toLowerCase()
          ? plan.pool.token0
          : plan.pool.token1;
      const outputToken =
        plan.summary.swapOutput.toLowerCase() === plan.pool.token0.address.toLowerCase()
          ? plan.pool.token0
          : plan.pool.token1;
      console.log(
        `  swap ${tokenAmount(plan.summary.swapAmountIn, inputToken.decimals)} ${inputToken.symbol} -> min ${tokenAmount(plan.summary.swapAmountOutMin, outputToken.decimals)} ${outputToken.symbol}`
      );
    }
    console.log(`  mint liquidity ${plan.summary.mintLiquidity.toString()}`);

    if (dryRun) {
      console.log("  DRY_RUN=true, tx not sent");
      return;
    }
    if (!(await checkGas())) return;

    const hash = await walletClient.writeContract({
      address: strategyAddress,
      abi: strategyAbi,
      functionName: "rebalance",
      args: plan.args,
      account
    });
    console.log(`  tx ${hash}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  confirmed block ${receipt.blockNumber.toString()} status ${receipt.status}`);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ${error.message}`);
  }
}

do {
  await tick();
  if (once) break;
  await sleep(checkSeconds * 1000);
} while (true);
