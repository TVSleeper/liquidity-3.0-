import { formatGwei, getAddress } from "viem";
import {
  DEFAULT_POOL_ID,
  applySlippageDown,
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
const rebalanceTickThreshold = Math.max(1, envNumber("REBALANCE_TICK_THRESHOLD", 0));
const maxGasGwei = envNumber("MAX_GAS_GWEI", 0);
const dryRun = envBoolean("DRY_RUN", true);
const once = envBoolean("RUN_ONCE", false);
const deadlineSeconds = Math.max(60, envNumber("DEADLINE_SECONDS", 20 * 60));
const minLiquidity = envBigInt("MIN_LIQUIDITY", 1n);

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

async function buildRebalance() {
  const strategyPaused = await publicClient.readContract({
    address: strategyAddress,
    abi: strategyAbi,
    functionName: "paused"
  });
  if (strategyPaused) throw new Error("Strategy is paused");

  const tokenId = await getStrategyTokenId();
  const pool = await loadPoolState(publicClient, poolId, poolKey, strategyAddress);
  const position = await readPositionById(publicClient, tokenId, poolId, strategyAddress);
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
      amount0After,
      amount1After,
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
