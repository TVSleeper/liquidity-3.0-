import { parseAbi, parseAbiItem } from "viem";

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
]);

export const permit2Abi = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)"
]);

export const clPoolManagerAbi = parseAbi([
  "function poolIdToPoolKey(bytes32 id) view returns (address currency0, address currency1, address hooks, address poolManager, uint24 fee, bytes32 parameters)",
  "function getSlot0(bytes32 id) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 id) view returns (uint128 liquidity)",
  "function getPosition(bytes32 id, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns ((uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128))"
]);

export const clPositionManagerAbi = parseAbi([
  "function modifyLiquidities(bytes payload, uint256 deadline) payable",
  "function nextTokenId() view returns (uint256)",
  "function ownerOf(uint256 id) view returns (address)",
  "function approve(address spender, uint256 id)",
  "function getApproved(uint256 id) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
  "function safeTransferFrom(address from, address to, uint256 id)",
  "function getPositionLiquidity(uint256 tokenId) view returns (uint128)",
  "function positions(uint256 tokenId) view returns ((address currency0,address currency1,address hooks,address poolManager,uint24 fee,bytes32 parameters) poolKey,int24 tickLower,int24 tickUpper,uint128 liquidity,uint256 feeGrowthInside0LastX128,uint256 feeGrowthInside1LastX128,address subscriber)"
]);

export const initializeEvent = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, address hooks, uint24 fee, bytes32 parameters, uint160 sqrtPriceX96, int24 tick)"
);

export const swapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee, uint16 protocolFee)"
);

export const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed id)"
);

export const atomicExecutorAbi = parseAbi([
  "constructor(address positionManager, address universalRouter, address permit2)",
  "function exitAndSwapToCurrency((address currency0,address currency1,address hooks,address poolManager,uint24 fee,bytes32 parameters) poolKey,uint256 tokenId,uint128 liquidityToRemove,uint128 amount0Min,uint128 amount1Min,address sellCurrency,address buyCurrency,uint128 amountOutMin,uint256 deadline)",
  "function rebalance((address currency0,address currency1,address hooks,address poolManager,uint24 fee,bytes32 parameters) poolKey,uint256 tokenId,uint128 liquidityToRemove,uint128 amount0Min,uint128 amount1Min,address swapInput,address swapOutput,uint128 swapAmountIn,uint128 swapAmountOutMin,int24 tickLower,int24 tickUpper,uint256 mintLiquidity,uint128 amount0Max,uint128 amount1Max,uint256 deadline) returns (uint256 newTokenId)",
  "function positionManager() view returns (address)",
  "function universalRouter() view returns (address)",
  "function permit2() view returns (address)"
]);

export const autonomousStrategyAbi = parseAbi([
  "function currentTokenId() view returns (uint256)",
  "function setCurrentTokenId(uint256 tokenId)",
  "function withdrawCurrentPosition(address to)"
]);
