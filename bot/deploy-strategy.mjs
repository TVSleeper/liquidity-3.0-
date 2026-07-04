import { getAddress } from "viem";
import {
  DEFAULT_POOL_ID,
  INFINITY_ADDRESSES,
  createClients,
  envBoolean,
  envNumber,
  envString,
  loadArtifact
} from "./shared.mjs";

const { account, publicClient, walletClient } = createClients();

const owner = getAddress(envString("OWNER_ADDRESS"));
const keeper = getAddress(envString("KEEPER_ADDRESS", account.address));
const poolId = envString("POOL_ID", DEFAULT_POOL_ID);
const maxTickWidth = Math.trunc(envNumber("MAX_TICK_WIDTH", 1000));
const forceNewExecutor = envBoolean("FORCE_NEW_EXECUTOR", false);

const atomicArtifact = loadArtifact("AtomicLiquidityExecutor");
const strategyArtifact = loadArtifact("AutonomousRangeStrategy");

let executorAddress = forceNewExecutor ? undefined : process.env.EXECUTOR_ADDRESS;

console.log(`Bot deployer: ${account.address}`);
console.log(`Owner:        ${owner}`);
console.log(`Keeper:       ${keeper}`);
console.log(`Pool ID:      ${poolId}`);
if (forceNewExecutor) console.log("Executor:     deploying new because FORCE_NEW_EXECUTOR=true");

if (!executorAddress) {
  console.log("Deploying AtomicLiquidityExecutor...");
  const hash = await walletClient.deployContract({
    abi: atomicArtifact.abi,
    bytecode: atomicArtifact.bytecode,
    args: [
      INFINITY_ADDRESSES.clPositionManager,
      INFINITY_ADDRESSES.universalRouter,
      INFINITY_ADDRESSES.permit2
    ],
    account
  });
  console.log(`Executor tx: ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("Executor deployment did not return contractAddress");
  executorAddress = receipt.contractAddress;
  console.log(`Executor:    ${executorAddress}`);
} else {
  executorAddress = getAddress(executorAddress);
  console.log(`Executor:    ${executorAddress}`);
}

console.log("Deploying AutonomousRangeStrategy...");
const strategyHash = await walletClient.deployContract({
  abi: strategyArtifact.abi,
  bytecode: strategyArtifact.bytecode,
  args: [
    owner,
    keeper,
    INFINITY_ADDRESSES.clPositionManager,
    executorAddress,
    poolId,
    maxTickWidth
  ],
  account
});
console.log(`Strategy tx: ${strategyHash}`);
const strategyReceipt = await publicClient.waitForTransactionReceipt({ hash: strategyHash });
if (!strategyReceipt.contractAddress) throw new Error("Strategy deployment did not return contractAddress");

console.log("");
console.log("Deployed:");
console.log(`EXECUTOR_ADDRESS=${executorAddress}`);
console.log(`STRATEGY_ADDRESS=${strategyReceipt.contractAddress}`);
console.log("");
console.log("Next:");
console.log("1. Add these addresses to .env.");
console.log("2. From the owner wallet, transfer the PancakeSwap LP NFT to STRATEGY_ADDRESS.");
console.log("3. Run npm run bot:run after the NFT is inside the strategy.");
