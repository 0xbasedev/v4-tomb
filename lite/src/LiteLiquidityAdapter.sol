// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

interface ILiteDexFactory {
    function getPair(address a, address b) external view returns (address);
}
interface ILiteDexRouter {
    function factory() external view returns (address);
    function addLiquidity(
        address tokenA, address tokenB, uint256 desiredA, uint256 desiredB,
        uint256 minA, uint256 minB, address receiver, uint256 deadline
    ) external returns (uint256 usedA, uint256 usedB, uint256 liquidity);
}
interface ILiteTransferToken {
    function balanceOf(address account) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

/// @notice Dedicated add-liquidity adapter. Only this inventory-backed path can bypass sell tax.
/// @dev Arbitrary router exemptions are forbidden: a router handles both sales and adds.
///      The adapter itself holds both tokens temporarily and exposes NO swap entrypoint.
contract LiteLiquidityAdapter {
    address public immutable tokenA;
    address public immutable tokenB;
    address public immutable pair;
    ILiteDexRouter public immutable router;
    uint256 private entered;

    error InvalidConfig();
    error TransferFailed();
    error Reentrancy();

    event LiquidityAdded(address indexed user, uint256 usedA, uint256 usedB, uint256 lpMinted);

    modifier lock() {
        if (entered != 0) revert Reentrancy();
        entered = 1;
        _;
        entered = 0;
    }

    constructor(address tokenA_, address tokenB_, address pair_, address router_, address factory_) {
        if (tokenA_ == address(0) || tokenB_ == address(0) ||
            tokenA_ == tokenB_ || pair_.code.length == 0 ||
            router_.code.length == 0 || factory_.code.length == 0 ||
            ILiteDexFactory(factory_).getPair(tokenA_, tokenB_) != pair_ ||
            ILiteDexRouter(router_).factory() != factory_) revert InvalidConfig();
        tokenA = tokenA_;
        tokenB = tokenB_;
        pair = pair_;
        router = ILiteDexRouter(router_);
    }

    function addLiquidity(
        uint256 amountA, uint256 amountB,
        uint256 minA, uint256 minB, uint256 deadline
    ) external lock returns (uint256 liquidity) {
        if (amountA == 0 || amountB == 0 || deadline < block.timestamp) revert InvalidConfig();
        _takeExact(tokenA, msg.sender, amountA);
        _takeExact(tokenB, msg.sender, amountB);
        _approve(tokenA, address(router), 0);
        _approve(tokenB, address(router), 0);
        _approve(tokenA, address(router), amountA);
        _approve(tokenB, address(router), amountB);

        uint256 usedA;
        uint256 usedB;
        (usedA, usedB, liquidity) = router.addLiquidity(
            tokenA, tokenB, amountA, amountB, minA, minB, msg.sender, deadline
        );
        if (usedA > amountA || usedB > amountB || liquidity == 0) revert InvalidConfig();
        _approve(tokenA, address(router), 0);
        _approve(tokenB, address(router), 0);
        if (usedA < amountA) _send(tokenA, msg.sender, amountA - usedA);
        if (usedB < amountB) _send(tokenB, msg.sender, amountB - usedB);
        emit LiquidityAdded(msg.sender, usedA, usedB, liquidity);
    }

    function _takeExact(address token, address from, uint256 amount) private {
        uint256 beforeBalance = ILiteTransferToken(token).balanceOf(address(this));
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(
            ILiteTransferToken.transferFrom.selector, from, address(this), amount
        ));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool))) ||
            ILiteTransferToken(token).balanceOf(address(this)) - beforeBalance != amount) {
            revert TransferFailed();
        }
    }

    function _approve(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(ILiteTransferToken.approve.selector, spender, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _send(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(ILiteTransferToken.transfer.selector, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
