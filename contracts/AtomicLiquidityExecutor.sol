// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address owner) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface ICLPositionManager {
    function nextTokenId() external view returns (uint256);
    function ownerOf(uint256 id) external view returns (address);
    function modifyLiquidities(bytes calldata payload, uint256 deadline) external payable;
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

struct PoolKey {
    address currency0;
    address currency1;
    address hooks;
    address poolManager;
    uint24 fee;
    bytes32 parameters;
}

struct CLSwapExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    bytes hookData;
}

contract AtomicLiquidityExecutor {
    uint256 private constant CL_DECREASE_LIQUIDITY = 0x01;
    uint256 private constant CL_MINT_POSITION = 0x02;
    uint256 private constant CL_SWAP_EXACT_IN_SINGLE = 0x06;
    uint256 private constant SETTLE = 0x0b;
    uint256 private constant TAKE = 0x0e;
    uint256 private constant TAKE_PAIR = 0x11;
    uint256 private constant CLOSE_CURRENCY = 0x12;
    uint256 private constant INFI_SWAP = 0x10;
    uint128 private constant OPEN_DELTA = 0;
    uint160 private constant MAX_UINT160 = type(uint160).max;
    uint48 private constant MAX_UINT48 = type(uint48).max;

    ICLPositionManager public immutable positionManager;
    IUniversalRouter public immutable universalRouter;
    IPermit2 public immutable permit2;

    error NotPositionOwner();
    error InvalidCurrency();
    error NothingToSwap();

    constructor(address _positionManager, address _universalRouter, address _permit2) {
        positionManager = ICLPositionManager(_positionManager);
        universalRouter = IUniversalRouter(_universalRouter);
        permit2 = IPermit2(_permit2);
    }

    function exitAndSwapToCurrency(
        PoolKey calldata poolKey,
        uint256 tokenId,
        uint128 liquidityToRemove,
        uint128 amount0Min,
        uint128 amount1Min,
        address sellCurrency,
        address buyCurrency,
        uint128 amountOutMin,
        uint256 deadline
    ) external {
        _assertOwner(tokenId);
        _decreaseToThis(poolKey, tokenId, liquidityToRemove, amount0Min, amount1Min, deadline);

        uint256 sellBalance = IERC20(sellCurrency).balanceOf(address(this));
        if (sellBalance == 0) revert NothingToSwap();
        _swapExactIn(poolKey, sellCurrency, buyCurrency, uint128(sellBalance), amountOutMin, msg.sender, deadline);

        _sweep(poolKey.currency0, msg.sender);
        _sweep(poolKey.currency1, msg.sender);
    }

    function rebalance(
        PoolKey calldata poolKey,
        uint256 tokenId,
        uint128 liquidityToRemove,
        uint128 amount0Min,
        uint128 amount1Min,
        address swapInput,
        address swapOutput,
        uint128 swapAmountIn,
        uint128 swapAmountOutMin,
        int24 tickLower,
        int24 tickUpper,
        uint256 mintLiquidity,
        uint128 amount0Max,
        uint128 amount1Max,
        uint256 deadline
    ) external returns (uint256 newTokenId) {
        _assertOwner(tokenId);
        _decreaseToThis(poolKey, tokenId, liquidityToRemove, amount0Min, amount1Min, deadline);

        if (swapAmountIn > 0) {
            _swapExactIn(
                poolKey,
                swapInput,
                swapOutput,
                swapAmountIn,
                swapAmountOutMin,
                address(this),
                deadline
            );
        }

        if (mintLiquidity > 0) {
            newTokenId = positionManager.nextTokenId();
            _approveForPositionManager(poolKey.currency0);
            _approveForPositionManager(poolKey.currency1);
            bytes[] memory params = new bytes[](3);
            bytes memory actions = new bytes(3);
            actions[0] = bytes1(uint8(CL_MINT_POSITION));
            actions[1] = bytes1(uint8(CLOSE_CURRENCY));
            actions[2] = bytes1(uint8(CLOSE_CURRENCY));
            params[0] = abi.encode(
                poolKey,
                tickLower,
                tickUpper,
                mintLiquidity,
                amount0Max,
                amount1Max,
                msg.sender,
                bytes("")
            );
            params[1] = abi.encode(poolKey.currency0);
            params[2] = abi.encode(poolKey.currency1);
            positionManager.modifyLiquidities(abi.encode(actions, params), deadline);
        }

        _sweep(poolKey.currency0, msg.sender);
        _sweep(poolKey.currency1, msg.sender);
    }

    function _assertOwner(uint256 tokenId) internal view {
        if (positionManager.ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
    }

    function _decreaseToThis(
        PoolKey calldata poolKey,
        uint256 tokenId,
        uint128 liquidityToRemove,
        uint128 amount0Min,
        uint128 amount1Min,
        uint256 deadline
    ) internal {
        bytes[] memory params = new bytes[](2);
        bytes memory actions = new bytes(2);
        actions[0] = bytes1(uint8(CL_DECREASE_LIQUIDITY));
        actions[1] = bytes1(uint8(TAKE_PAIR));
        params[0] = abi.encode(tokenId, liquidityToRemove, amount0Min, amount1Min, bytes(""));
        params[1] = abi.encode(poolKey.currency0, poolKey.currency1, address(this));
        positionManager.modifyLiquidities(abi.encode(actions, params), deadline);
    }

    function _swapExactIn(
        PoolKey calldata poolKey,
        address input,
        address output,
        uint128 amountIn,
        uint128 amountOutMin,
        address recipient,
        uint256 deadline
    ) internal {
        if (
            !((input == poolKey.currency0 && output == poolKey.currency1)
                || (input == poolKey.currency1 && output == poolKey.currency0))
        ) revert InvalidCurrency();

        IERC20(input).approve(address(permit2), amountIn);
        permit2.approve(input, address(universalRouter), MAX_UINT160, MAX_UINT48);

        bytes[] memory params = new bytes[](3);
        bytes memory actions = new bytes(3);
        actions[0] = bytes1(uint8(CL_SWAP_EXACT_IN_SINGLE));
        actions[1] = bytes1(uint8(SETTLE));
        actions[2] = bytes1(uint8(TAKE));

        params[0] = abi.encode(
            CLSwapExactInputSingleParams({
                poolKey: poolKey,
                zeroForOne: input == poolKey.currency0,
                amountIn: amountIn,
                amountOutMinimum: amountOutMin,
                hookData: bytes("")
            })
        );
        params[1] = abi.encode(input, OPEN_DELTA, true);
        params[2] = abi.encode(output, recipient, OPEN_DELTA);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        universalRouter.execute(abi.encodePacked(bytes1(uint8(INFI_SWAP))), inputs, deadline);
    }

    function _approveForPositionManager(address token) internal {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) return;
        IERC20(token).approve(address(permit2), balance);
        permit2.approve(token, address(positionManager), MAX_UINT160, MAX_UINT48);
    }

    function _sweep(address token, address recipient) internal {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) IERC20(token).transfer(recipient, balance);
    }
}
