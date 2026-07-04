// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./AtomicLiquidityExecutor.sol";

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

interface ICLPositionManagerNft is ICLPositionManager {
    function approve(address spender, uint256 id) external;
    function safeTransferFrom(address from, address to, uint256 id) external;
}

interface IAtomicLiquidityExecutor {
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
    ) external returns (uint256 newTokenId);
}

contract AutonomousRangeStrategy is IERC721Receiver {
    address public owner;
    address public keeper;
    ICLPositionManagerNft public immutable positionManager;
    IAtomicLiquidityExecutor public immutable executor;
    bytes32 public immutable poolId;
    uint256 public currentTokenId;
    int24 public maxTickWidth;
    bool public paused;

    event KeeperUpdated(address indexed keeper);
    event PausedUpdated(bool paused);
    event MaxTickWidthUpdated(int24 maxTickWidth);
    event PositionReceived(uint256 indexed tokenId, address indexed from);
    event PositionSet(uint256 indexed tokenId);
    event PositionWithdrawn(uint256 indexed tokenId, address indexed to);
    event TokenWithdrawn(address indexed token, address indexed to, uint256 amount);
    event Rebalanced(uint256 indexed oldTokenId, uint256 indexed newTokenId, int24 tickLower, int24 tickUpper);

    error NotOwner();
    error NotKeeperOrOwner();
    error Paused();
    error ZeroAddress();
    error InvalidPool();
    error InvalidTicks();
    error InvalidTokenId();
    error NotPositionOwner();
    error NothingToMint();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyKeeperOrOwner() {
        if (msg.sender != keeper && msg.sender != owner) revert NotKeeperOrOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor(
        address _owner,
        address _keeper,
        address _positionManager,
        address _executor,
        bytes32 _poolId,
        int24 _maxTickWidth
    ) {
        if (_owner == address(0) || _keeper == address(0) || _positionManager == address(0) || _executor == address(0)) {
            revert ZeroAddress();
        }
        if (_maxTickWidth <= 0) revert InvalidTicks();
        owner = _owner;
        keeper = _keeper;
        positionManager = ICLPositionManagerNft(_positionManager);
        executor = IAtomicLiquidityExecutor(_executor);
        poolId = _poolId;
        maxTickWidth = _maxTickWidth;
    }

    function setKeeper(address nextKeeper) external onlyOwner {
        if (nextKeeper == address(0)) revert ZeroAddress();
        keeper = nextKeeper;
        emit KeeperUpdated(nextKeeper);
    }

    function setPaused(bool nextPaused) external onlyOwner {
        paused = nextPaused;
        emit PausedUpdated(nextPaused);
    }

    function setMaxTickWidth(int24 nextMaxTickWidth) external onlyOwner {
        if (nextMaxTickWidth <= 0) revert InvalidTicks();
        maxTickWidth = nextMaxTickWidth;
        emit MaxTickWidthUpdated(nextMaxTickWidth);
    }

    function setCurrentTokenId(uint256 tokenId) external onlyOwner {
        if (positionManager.ownerOf(tokenId) != address(this)) revert NotPositionOwner();
        currentTokenId = tokenId;
        emit PositionSet(tokenId);
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
    ) external onlyKeeperOrOwner whenNotPaused {
        if (tokenId == 0 || tokenId != currentTokenId) revert InvalidTokenId();
        if (positionManager.ownerOf(tokenId) != address(this)) revert NotPositionOwner();
        if (keccak256(abi.encode(poolKey)) != poolId) revert InvalidPool();
        _validateTicks(tickLower, tickUpper);
        if (mintLiquidity == 0) revert NothingToMint();

        positionManager.approve(address(executor), tokenId);
        uint256 oldTokenId = currentTokenId;
        uint256 newTokenId = executor.rebalance(
            poolKey,
            tokenId,
            liquidityToRemove,
            amount0Min,
            amount1Min,
            swapInput,
            swapOutput,
            swapAmountIn,
            swapAmountOutMin,
            tickLower,
            tickUpper,
            mintLiquidity,
            amount0Max,
            amount1Max,
            deadline
        );
        if (newTokenId != 0) currentTokenId = newTokenId;

        emit Rebalanced(oldTokenId, currentTokenId, tickLower, tickUpper);
    }

    function withdrawCurrentPosition(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 tokenId = currentTokenId;
        if (tokenId == 0) revert InvalidTokenId();
        currentTokenId = 0;
        positionManager.safeTransferFrom(address(this), to, tokenId);
        emit PositionWithdrawn(tokenId, to);
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 amountToSend = amount == type(uint256).max ? balance : amount;
        IERC20(token).transfer(to, amountToSend);
        emit TokenWithdrawn(token, to, amountToSend);
    }

    function onERC721Received(address, address from, uint256 tokenId, bytes calldata)
        external
        returns (bytes4)
    {
        if (msg.sender != address(positionManager)) revert ZeroAddress();
        currentTokenId = tokenId;
        emit PositionReceived(tokenId, from);
        return IERC721Receiver.onERC721Received.selector;
    }

    receive() external payable {}

    function _validateTicks(int24 tickLower, int24 tickUpper) internal view {
        if (tickUpper <= tickLower) revert InvalidTicks();
        int24 width = tickUpper - tickLower;
        if (width > maxTickWidth) revert InvalidTicks();
    }
}
