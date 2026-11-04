// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IMasonryRedeemableLPVault} from "./MasonryGenesisLPBurnFee.sol";
import {MasonryLevelHook} from "../hooks/MasonryLevelHook.sol";

/// @notice Fungible shares in one immutable official LEVEL/USDC v4 range.
/// One raw share represents one unit of position liquidity and a pro-rata
/// share of earned fees. Unsolicited transfers do not enter fee accounting.
contract MasonryLevelUsdcVault is ERC20, ReentrancyGuard, IUnlockCallback, IMasonryRedeemableLPVault {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable manager;
    int24 public immutable tickLower;
    int24 public immutable tickUpper;
    bool public immutable levelIsCurrency0;
    PoolKey private key;

    uint256 public feeReserve0;
    uint256 public feeReserve1;

    struct Action {
        address payer;
        address recipient;
        uint256 shares;
        uint256 limit0;
        uint256 limit1;
        bool deposit;
    }

    error InvalidConfiguration();
    error InvalidAmount();
    error InvalidSettlement();
    error Slippage();
    error NotPoolManager();

    event LiquidityDeposited(
        address indexed payer, address indexed recipient, uint256 shares, uint256 level, uint256 usdc
    );
    event LiquidityRedeemed(
        address indexed holder, address indexed recipient, uint256 shares, uint256 level, uint256 usdc
    );

    constructor(
        PoolKey memory pool,
        int24 lower,
        int24 upper
    ) ERC20("Masonry LEVEL/USDC LP", "mLEVEL-USDC") {
        MasonryLevelHook hook = MasonryLevelHook(address(pool.hooks));
        if (
            address(hook).code.length == 0 || PoolId.unwrap(pool.toId()) != PoolId.unwrap(hook.officialPool())
                || pool.tickSpacing <= 0 || lower >= upper || lower < TickMath.MIN_TICK || upper > TickMath.MAX_TICK
                || lower % pool.tickSpacing != 0 || upper % pool.tickSpacing != 0
        ) revert InvalidConfiguration();
        manager = hook.poolManager();
        levelIsCurrency0 = hook.levelIsCurrency0();
        tickLower = lower;
        tickUpper = upper;
        key = pool;
    }

    function poolKey() external view returns (PoolKey memory) {
        return key;
    }

    /// @notice Mint exactly shares units of liquidity, subject to token input caps
    /// that include the new holder's contribution toward accrued fees.
    function deposit(
        uint256 shares,
        uint256 maxLevel,
        uint256 maxUsdc,
        address recipient
    ) external nonReentrant returns (uint256 levelIn, uint256 usdcIn) {
        (levelIn, usdcIn) = _execute(shares, maxLevel, maxUsdc, recipient, true);
        emit LiquidityDeposited(msg.sender, recipient, shares, levelIn, usdcIn);
    }

    /// @notice Redemption interface for the Genesis fee collector.
    function redeem(
        uint256 shares,
        address recipient
    ) external returns (uint256 levelOut, uint256 usdcOut) {
        return redeem(shares, 0, 0, recipient);
    }

    /// @notice Redeem a holder's own shares, with optional per-token output floors.
    function redeem(
        uint256 shares,
        uint256 minLevel,
        uint256 minUsdc,
        address recipient
    ) public nonReentrant returns (uint256 levelOut, uint256 usdcOut) {
        (levelOut, usdcOut) = _execute(shares, minLevel, minUsdc, recipient, false);
        emit LiquidityRedeemed(msg.sender, recipient, shares, levelOut, usdcOut);
    }

    function _execute(
        uint256 shares,
        uint256 levelLimit,
        uint256 usdcLimit,
        address recipient,
        bool isDeposit
    ) private returns (uint256 levelAmount, uint256 usdcAmount) {
        if (
            shares == 0 || shares > uint256(uint128(type(int128).max)) || recipient == address(0)
                || recipient == address(this) || recipient == address(manager)
        ) revert InvalidAmount();
        (uint256 limit0, uint256 limit1) = levelIsCurrency0 ? (levelLimit, usdcLimit) : (usdcLimit, levelLimit);
        Action memory action = Action(msg.sender, recipient, shares, limit0, limit1, isDeposit);
        (uint256 amount0, uint256 amount1) = abi.decode(manager.unlock(abi.encode(action)), (uint256, uint256));
        return levelIsCurrency0 ? (amount0, amount1) : (amount1, amount0);
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotPoolManager();
        Action memory action = abi.decode(data, (Action));
        (uint256 amount0, uint256 amount1) = action.deposit ? _deposit(action) : _redeem(action);
        return abi.encode(amount0, amount1);
    }

    function _deposit(
        Action memory action
    ) private returns (uint256 amount0, uint256 amount1) {
        uint256 supply = totalSupply();
        if (supply != 0) _collectFees();
        (BalanceDelta delta, BalanceDelta fees) = _modify(int256(action.shares));
        if (fees.amount0() != 0 || fees.amount1() != 0) revert InvalidSettlement();

        uint256 principal0 = _positive(-int256(delta.amount0()));
        uint256 principal1 = _positive(-int256(delta.amount1()));
        uint256 equalize0 = supply == 0 ? 0 : FullMath.mulDivRoundingUp(feeReserve0, action.shares, supply);
        uint256 equalize1 = supply == 0 ? 0 : FullMath.mulDivRoundingUp(feeReserve1, action.shares, supply);
        amount0 = principal0 + equalize0;
        amount1 = principal1 + equalize1;
        if (amount0 > action.limit0 || amount1 > action.limit1) revert Slippage();

        feeReserve0 += equalize0;
        feeReserve1 += equalize1;
        _pay(key.currency0, action.payer, principal0, equalize0);
        _pay(key.currency1, action.payer, principal1, equalize1);
        _mint(action.recipient, action.shares);
    }

    function _redeem(
        Action memory action
    ) private returns (uint256 amount0, uint256 amount1) {
        uint256 supply = totalSupply();
        _burn(action.payer, action.shares);
        (BalanceDelta delta, BalanceDelta fees) = _modify(-int256(action.shares));
        uint256 fee0 = _positive(fees.amount0());
        uint256 fee1 = _positive(fees.amount1());
        uint256 share0 = FullMath.mulDiv(feeReserve0 + fee0, action.shares, supply);
        uint256 share1 = FullMath.mulDiv(feeReserve1 + fee1, action.shares, supply);
        amount0 = _positive(int256(delta.amount0()) - fees.amount0()) + share0;
        amount1 = _positive(int256(delta.amount1()) - fees.amount1()) + share1;
        if (amount0 < action.limit0 || amount1 < action.limit1) revert Slippage();

        feeReserve0 += fee0;
        feeReserve1 += fee1;
        feeReserve0 -= share0;
        feeReserve1 -= share1;
        _take(key.currency0, _positive(delta.amount0()));
        _take(key.currency1, _positive(delta.amount1()));
        if (amount0 != 0) IERC20(Currency.unwrap(key.currency0)).safeTransfer(action.recipient, amount0);
        if (amount1 != 0) IERC20(Currency.unwrap(key.currency1)).safeTransfer(action.recipient, amount1);
    }

    function _collectFees() private {
        (BalanceDelta delta, BalanceDelta fees) = _modify(0);
        if (BalanceDelta.unwrap(delta) != BalanceDelta.unwrap(fees)) revert InvalidSettlement();
        uint256 amount0 = _positive(delta.amount0());
        uint256 amount1 = _positive(delta.amount1());
        feeReserve0 += amount0;
        feeReserve1 += amount1;
        _take(key.currency0, amount0);
        _take(key.currency1, amount1);
    }

    function _modify(
        int256 change
    ) private returns (BalanceDelta delta, BalanceDelta fees) {
        return manager.modifyLiquidity(key, ModifyLiquidityParams(tickLower, tickUpper, change, bytes32(0)), "");
    }

    function _pay(
        Currency currency,
        address payer,
        uint256 principal,
        uint256 equalization
    ) private {
        IERC20 token = IERC20(Currency.unwrap(currency));
        if (equalization != 0) {
            uint256 beforeBalance = token.balanceOf(address(this));
            token.safeTransferFrom(payer, address(this), equalization);
            if (token.balanceOf(address(this)) - beforeBalance != equalization) revert InvalidSettlement();
        }
        if (principal != 0) {
            manager.sync(currency);
            token.safeTransferFrom(payer, address(manager), principal);
            if (manager.settle() != principal) revert InvalidSettlement();
        }
    }

    function _take(
        Currency currency,
        uint256 amount
    ) private {
        if (amount != 0) manager.take(currency, address(this), amount);
    }

    function _positive(
        int256 amount
    ) private pure returns (uint256) {
        if (amount < 0) revert InvalidSettlement();
        return uint256(amount);
    }
}
