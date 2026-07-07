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

contract PancakeV3ExitSeller is IERC721Receiver {
    IPancakeV3PositionManager public immutable positionManager;
    IPancakeV3SwapRouter public immutable swapRouter;
    address public immutable upToken;
    address public immutable wbnb;

    error InvalidPosition();
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

    constructor(address _positionManager, address _swapRouter, address _upToken, address _wbnb) {
        if (_positionManager == address(0) || _swapRouter == address(0) || _upToken == address(0) || _wbnb == address(0)) {
            revert InvalidPosition();
        }
        positionManager = IPancakeV3PositionManager(_positionManager);
        swapRouter = IPancakeV3SwapRouter(_swapRouter);
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
            _approve(upToken, address(swapRouter), 0);
            _approve(upToken, address(swapRouter), upBalance);
            try swapRouter.exactInputSingle(
                IPancakeV3SwapRouter.ExactInputSingleParams({
                    tokenIn: upToken,
                    tokenOut: wbnb,
                    fee: fee,
                    recipient: address(this),
                    deadline: deadline,
                    amountIn: upBalance,
                    amountOutMinimum: minBnbOut,
                    sqrtPriceLimitX96: 0
                })
            ) returns (uint256 amountOut) {
                upSold = upBalance;
                amountOut;
            } catch {
                if (minBnbOut > 0) revert TokenCallFailed();
                _approve(upToken, address(swapRouter), 0);
            }
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

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {}

    function _approve(address token, address spender, uint256 amount) internal {
        (bool success, bytes memory data) =
            token.call(abi.encodeWithSelector(bytes4(keccak256("approve(address,uint256)")), spender, amount));
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }

    function _sweep(address token, address recipient) internal {
        uint256 balance = IERC20Optional(token).balanceOf(address(this));
        if (balance == 0) return;
        (bool success, bytes memory data) =
            token.call(abi.encodeWithSelector(bytes4(keccak256("transfer(address,uint256)")), recipient, balance));
        if (!success || (data.length > 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }

    function _sendNative(address recipient, uint256 amount) internal {
        (bool success,) = recipient.call{ value: amount }("");
        if (!success) revert NativeTransferFailed();
    }
}
