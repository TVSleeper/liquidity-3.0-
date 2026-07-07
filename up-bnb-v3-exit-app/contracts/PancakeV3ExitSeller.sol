// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Optional {
    function balanceOf(address owner) external view returns (uint256);
}

interface IWBNB is IERC20Optional {
    function withdraw(uint256 amount) external;
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

interface IPancakeV3PositionManager {
    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function ownerOf(uint256 tokenId) external view returns (address);

    function safeTransferFrom(address from, address to, uint256 tokenId) external;

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);
}

interface IPancakeV3SwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

interface IPancakeV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);

    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

contract PancakeV3ExitSeller is IERC721Receiver {
    uint160 private constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    IPancakeV3PositionManager public immutable positionManager;
    IPancakeV3SwapRouter public immutable swapRouter;
    IPancakeV3Pool public immutable v3Pool;
    address public immutable upToken;
    address public immutable wbnb;

    error InvalidPosition();
    error InvalidPool();
    error InvalidSwapCallback();
    error InsufficientOutput();
    error NotPositionOwner();
    error ZeroLiquidity();
    error NativeTransferFailed();
    error TokenCallFailed();

    event ExitSold(
        address indexed owner,
        uint256 indexed tokenId,
        uint128 liquidityRemoved,
        uint256 upSold,
        uint256 bnbOut
    );

    event ExitOnly(
        address indexed owner,
        uint256 indexed tokenId,
        uint128 liquidityRemoved,
        uint256 upOut,
        uint256 bnbOut
    );

    constructor(address _positionManager, address _swapRouter, address _v3Pool, address _upToken, address _wbnb) {
        if (
            _positionManager == address(0) || _swapRouter == address(0) || _v3Pool == address(0)
                || _upToken == address(0) || _wbnb == address(0)
        ) {
            revert InvalidPosition();
        }
        positionManager = IPancakeV3PositionManager(_positionManager);
        swapRouter = IPancakeV3SwapRouter(_swapRouter);
        v3Pool = IPancakeV3Pool(_v3Pool);
        upToken = _upToken;
        wbnb = _wbnb;
    }

    function exitSellUpForBnb(
        uint256 tokenId,
        uint128 liquidityToRemove,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 minBnbOut,
        uint256 deadline
    ) external returns (uint256 bnbOut) {
        (, bnbOut) = _exit(tokenId, liquidityToRemove, amount0Min, amount1Min, minBnbOut, deadline, true);
    }

    function exitOnly(
        uint256 tokenId,
        uint128 liquidityToRemove,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 deadline
    ) external returns (uint256 upOut, uint256 bnbOut) {
        (upOut, bnbOut) = _exit(tokenId, liquidityToRemove, amount0Min, amount1Min, 0, deadline, false);
    }

    function _exit(
        uint256 tokenId,
        uint128 liquidityToRemove,
        uint256 amount0Min,
        uint256 amount1Min,
        uint256 minBnbOut,
        uint256 deadline,
        bool trySellUp
    ) internal returns (uint256 upOut, uint256 bnbOut) {
        if (positionManager.ownerOf(tokenId) != msg.sender) revert NotPositionOwner();
        if (liquidityToRemove == 0) revert ZeroLiquidity();

        positionManager.safeTransferFrom(msg.sender, address(this), tokenId);

        (,, address token0, address token1, uint24 fee,,,,,,,) = positionManager.positions(tokenId);
        if (!((token0 == upToken && token1 == wbnb) || (token0 == wbnb && token1 == upToken))) {
            positionManager.safeTransferFrom(address(this), msg.sender, tokenId);
            revert InvalidPosition();
        }
        if (v3Pool.token0() != token0 || v3Pool.token1() != token1 || v3Pool.fee() != fee) {
            positionManager.safeTransferFrom(address(this), msg.sender, tokenId);
            revert InvalidPool();
        }

        positionManager.decreaseLiquidity(
            IPancakeV3PositionManager.DecreaseLiquidityParams({
                tokenId: tokenId,
                liquidity: liquidityToRemove,
                amount0Min: amount0Min,
                amount1Min: amount1Min,
                deadline: deadline
            })
        );

        positionManager.collect(
            IPancakeV3PositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        uint256 upBalance = IERC20Optional(upToken).balanceOf(address(this));
        uint256 upSold;
        if (trySellUp && upBalance > 0) {
            _swapUpForWbnb(token0, token1, upBalance, minBnbOut);
            upSold = upBalance;
        }

        uint256 wbnbBalance = IERC20Optional(wbnb).balanceOf(address(this));
        if (wbnbBalance > 0) {
            IWBNB(wbnb).withdraw(wbnbBalance);
            _sendNative(msg.sender, wbnbBalance);
            bnbOut = wbnbBalance;
        }

        upOut = IERC20Optional(upToken).balanceOf(address(this));
        _sweep(upToken, msg.sender);
        _sweep(wbnb, msg.sender);
        positionManager.safeTransferFrom(address(this), msg.sender, tokenId);

        if (trySellUp) {
            emit ExitSold(msg.sender, tokenId, liquidityToRemove, upSold, bnbOut);
        } else {
            emit ExitOnly(msg.sender, tokenId, liquidityToRemove, upBalance, bnbOut);
        }
    }

    function pancakeV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _v3SwapCallback(amount0Delta, amount1Delta, data);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _v3SwapCallback(amount0Delta, amount1Delta, data);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {}

    function _swapUpForWbnb(address token0, address token1, uint256 upAmountIn, uint256 minBnbOut) internal {
        if (upAmountIn > uint256(type(int256).max)) revert TokenCallFailed();

        bool zeroForOne = token0 == upToken;
        uint256 beforeWbnb = IERC20Optional(wbnb).balanceOf(address(this));
        v3Pool.swap(
            address(this),
            zeroForOne,
            int256(upAmountIn),
            zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
            abi.encode(token0, token1)
        );
        uint256 amountOut = IERC20Optional(wbnb).balanceOf(address(this)) - beforeWbnb;
        if (amountOut < minBnbOut) revert InsufficientOutput();
    }

    function _v3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) internal {
        if (msg.sender != address(v3Pool)) revert InvalidSwapCallback();
        (address token0, address token1) = abi.decode(data, (address, address));
        if (!((token0 == upToken && token1 == wbnb) || (token0 == wbnb && token1 == upToken))) {
            revert InvalidPool();
        }
        if (amount0Delta > 0) _transferToken(token0, msg.sender, uint256(amount0Delta));
        if (amount1Delta > 0) _transferToken(token1, msg.sender, uint256(amount1Delta));
    }

    function _approve(address token, address spender, uint256 amount) internal {
        (bool success, bytes memory data) =
            token.call(abi.encodeWithSelector(bytes4(keccak256("approve(address,uint256)")), spender, amount));
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }

    function _sweep(address token, address recipient) internal {
        uint256 balance = IERC20Optional(token).balanceOf(address(this));
        if (balance == 0) return;
        _transferToken(token, recipient, balance);
    }

    function _transferToken(address token, address recipient, uint256 amount) internal {
        (bool success, bytes memory data) =
            token.call(abi.encodeWithSelector(bytes4(keccak256("transfer(address,uint256)")), recipient, amount));
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }

    function _sendNative(address recipient, uint256 amount) internal {
        (bool success,) = recipient.call{ value: amount }("");
        if (!success) revert NativeTransferFailed();
    }
}
