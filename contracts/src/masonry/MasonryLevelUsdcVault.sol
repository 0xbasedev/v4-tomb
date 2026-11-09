// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {MasonryTaxHook} from "../hooks/MasonryTaxHook.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IMasonryRedeemableLPVault} from "./MasonryGenesisLPBurnFee.sol";
import {MasonryLevelHook} from "../hooks/MasonryLevelHook.sol";
import {MasonryBuybackGuard} from "./MasonryBuybackGuard.sol";
import {MasonryCriticalDefense} from "./MasonryCriticalDefense.sol";
import {MasonryGenesisSchedule} from "./MasonryGenesisSchedule.sol";
import {MasonryLevelOracle} from "./MasonryLevelOracle.sol";
import {MasonryLevelPrice} from "./MasonryLevelPrice.sol";
import {MiniSwapRouter} from "../swap/MiniSwapRouter.sol";

/// @notice Fungible shares in one official asset/USDC v4 range, with
/// auto-range v2: the range is storage, not immutable, and moves only via
/// the parameterless, guard-railed rebalance() (auto-range design
/// 2026-11-08, option (a)). Shares are claims on the vault, not on a range:
/// deposits and redemptions convert shares to position liquidity through
/// the totalPositionLiquidity exchange rate, because a range change makes
/// 1 share = 1 liquidity unit insolvent. Unsolicited transfers do not
/// enter fee accounting.
/// @dev Centering modes (spec correction, Jess 2026-11-08 21:43 EST):
/// TWAP-centered vaults (SQUARE) center the new range on the validated
/// TWAP tick. Peg-centered vaults (LEVEL) center on the configured peg and
/// never chase price: the TWAP is only a health/fail-closed signal there,
/// and below the depeg threshold the vault holds its peg band instead of
/// recentering down.
abstract contract MasonryUsdcVault is ERC20, ReentrancyGuard, Ownable, IUnlockCallback, IMasonryRedeemableLPVault {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager public immutable manager;
    bool public immutable assetIsCurrency0;
    bool public immutable pegCentered;
    MasonryLevelOracle public immutable oracle;
    MasonryBuybackGuard public immutable guard;
    MiniSwapRouter public immutable router;
    MasonryCriticalDefense public immutable defense;
    MasonryGenesisSchedule public immutable schedule;
    PoolId internal immutable poolId;
    PoolKey internal key;

    /// @notice Current position range. Storage (v2): changed only by a
    /// successful rebalance(). Downstream readers (the SQUARE hook's POL
    /// leg) read these live, exactly as they read the v1 immutables.
    int24 public tickLower;
    int24 public tickUpper;

    /// @notice The position's liquidity at the current range. Always equals
    /// the PoolManager position liquidity for (this vault, tickLower,
    /// tickUpper, salt 0). Shares convert through this exchange rate.
    uint256 public totalPositionLiquidity;

    uint256 public feeReserve0;
    uint256 public feeReserve1;

    // ---- Auto-range parameters (owner-set; design section 6 defaults) ----
    uint32 public rebalanceCooldown;
    uint32 public pokeDelay;
    uint16 public maxLossBps;
    uint256 public minPositionValueUsd;
    uint256 public minSwapValueUsd;
    // Price-following (TWAP) range construction: SEPARATE asymmetric
    // widths, never one symmetric width (design input 2026-11-08).
    uint24 public lowerWidthTicks;
    uint24 public upperWidthTicks;
    uint24 public maxWidthTicks;
    int256 public volatilityTicks;
    // Exact-trigger numerator (Jess 2026-11-08 22:06): each side's
    // recenter threshold is span * driftNumerator / that side's width.
    uint24 public driftNumerator;
    uint256 public pegPrice;
    uint256 public depegThresholdPrice;
    uint256 public lastRebalanceAt;
    mapping(address keeper => bool enabled) public keepers;

    // ---- Expected-fees gate (quality-bar point 3) ----
    // A rebalance may fire only if the position's expected fee earnings
    // over feeGateHorizon exceed the rebalance swap leg's cost times the
    // margin. The estimate is built from the pool's fee-growth globals,
    // snapshotted into a pair (prev, last) that always spans at least
    // feeGateWindow; see _expectedFeesUsd for the estimator and its
    // documented assumptions. Defaults are production-shaped: a 24h
    // trailing window, a 24h horizon, and a 100% margin (expected fees
    // must exceed 1.0x the leg cost). feeGateMarginBps == 0 is the
    // explicit admin off-switch.
    uint32 public feeGateHorizon;
    uint32 public feeGateWindow;
    uint32 public feeGateMarginBps;
    uint256 public feeGatePrevGrowth0;
    uint256 public feeGatePrevGrowth1;
    uint256 public feeGatePrevAt;
    uint256 public feeGateLastGrowth0;
    uint256 public feeGateLastGrowth1;
    uint256 public feeGateLastAt;

    uint256 private _rbAmount0;
    uint256 private _rbAmount1;
    uint256 private _rbPaid0;
    uint256 private _rbPaid1;

    struct Action {
        address payer;
        address recipient;
        uint256 shares;
        uint256 limit0;
        uint256 limit1;
        bool deposit;
    }

    struct RebalanceStep {
        int24 lower;
        int24 upper;
        uint256 liquidity;
        bool mint;
    }

    struct RebalanceRun {
        uint256 twap;
        int24 twapTick;
        int24 oldLower;
        int24 oldUpper;
        int24 newLower;
        int24 newUpper;
        uint256 valueBefore;
        uint256 valueAfter;
        uint256 bal0;
        uint256 bal1;
        bool soldAsset;
        bool boughtAsset;
        uint256 newLiquidity;
    }

    error InvalidConfiguration();
    error InvalidAmount();
    error InvalidSettlement();
    error Slippage();
    error NotPoolManager();
    error InvalidParameters();
    error NotKeeper();
    error CooldownActive(uint256 eligibleAt);
    error GenesisLocked(uint256 endsAt);
    error DefenseActive();
    error OracleInvalid();
    error DepegHold();
    error NotEligible();
    error RangeClamp();
    error PositionTooSmall();
    error LossCapExceeded();
    error NotCostEffective(uint256 expectedFeesUsd, uint256 requiredFeesUsd);

    event LiquidityDeposited(
        address indexed payer, address indexed recipient, uint256 shares, uint256 level, uint256 usdc
    );
    event LiquidityRedeemed(
        address indexed holder, address indexed recipient, uint256 shares, uint256 level, uint256 usdc
    );
    event KeeperUpdated(address indexed keeper, bool enabled);
    event RebalanceParamsUpdated(
        uint32 rebalanceCooldown,
        uint32 pokeDelay,
        uint16 maxLossBps,
        uint256 minPositionValueUsd,
        uint256 minSwapValueUsd
    );
    event RangeBoundsUpdated(
        uint24 lowerWidthTicks, uint24 upperWidthTicks, uint24 maxWidthTicks, int256 volatilityTicks, uint24 driftNumerator
    );
    event PegParamsUpdated(uint256 pegPrice, uint256 depegThresholdPrice);
    event FeeGateParamsUpdated(uint32 feeGateHorizon, uint32 feeGateWindow, uint32 feeGateMarginBps);
    event Rebalanced(
        PoolId poolId,
        int24 oldLower,
        int24 oldUpper,
        int24 newLower,
        int24 newUpper,
        int24 twapTick,
        uint256 liquidityBefore,
        uint256 liquidityAfter,
        bool soldAsset,
        bool boughtAsset,
        uint256 valueBefore,
        uint256 valueAfter,
        address indexed keeper
    );

    constructor(
        PoolKey memory pool,
        int24 lower,
        int24 upper,
        string memory name_,
        string memory symbol_,
        MasonryBuybackGuard guard_,
        MiniSwapRouter router_,
        MasonryCriticalDefense defense_,
        MasonryGenesisSchedule schedule_,
        bool pegCentered_,
        uint24 lowerWidthTicks_,
        uint24 upperWidthTicks_,
        address owner_
    ) ERC20(name_, symbol_) Ownable(owner_) {
        MasonryTaxHook hook = MasonryTaxHook(address(pool.hooks));
        if (
            address(hook).code.length == 0 || PoolId.unwrap(pool.toId()) != PoolId.unwrap(hook.officialPool())
                || pool.tickSpacing <= 0 || lower >= upper || lower < TickMath.MIN_TICK || upper > TickMath.MAX_TICK
                || lower % pool.tickSpacing != 0 || upper % pool.tickSpacing != 0
        ) revert InvalidConfiguration();
        if (
            address(guard_).code.length == 0 || address(router_).code.length == 0
                || PoolId.unwrap(guard_.officialPool()) != PoolId.unwrap(pool.toId())
                || router_.poolManager() != hook.poolManager()
                || (address(defense_) != address(0) && address(defense_).code.length == 0)
                || (address(schedule_) != address(0) && address(schedule_).code.length == 0)
                || lowerWidthTicks_ == 0 || upperWidthTicks_ == 0 || lowerWidthTicks_ > 4_000
                || upperWidthTicks_ > 4_000
        ) revert InvalidConfiguration();
        manager = hook.poolManager();
        assetIsCurrency0 = hook.assetIsCurrency0();
        oracle = hook.oracle();
        guard = guard_;
        router = router_;
        defense = defense_;
        schedule = schedule_;
        pegCentered = pegCentered_;
        poolId = pool.toId();
        tickLower = lower;
        tickUpper = upper;
        key = pool;

        // Auto-range defaults (design section 6). All owner-adjustable.
        rebalanceCooldown = 6 hours;
        pokeDelay = 24 hours;
        maxLossBps = 100;
        minPositionValueUsd = 1_000e18;
        minSwapValueUsd = 1e18;
        lowerWidthTicks = lowerWidthTicks_;
        upperWidthTicks = upperWidthTicks_;
        maxWidthTicks = 4_000;
        driftNumerator = 666;
        pegPrice = 1e18;
        depegThresholdPrice = 0.90e18;
        feeGateHorizon = 24 hours;
        feeGateWindow = 24 hours;
        feeGateMarginBps = 10_000;
    }

    function poolKey() external view returns (PoolKey memory) {
        return key;
    }

    // ------------------------------------------------------------------
    // Owner administration (design section 3: the keeper changes none of
    // these; every change is evented).
    // ------------------------------------------------------------------

    function setKeeper(
        address keeper,
        bool enabled
    ) external onlyOwner {
        if (keeper == address(0)) revert InvalidConfiguration();
        keepers[keeper] = enabled;
        emit KeeperUpdated(keeper, enabled);
    }

    function setRebalanceParams(
        uint32 rebalanceCooldown_,
        uint32 pokeDelay_,
        uint16 maxLossBps_,
        uint256 minPositionValueUsd_,
        uint256 minSwapValueUsd_
    ) external onlyOwner {
        if (
            maxLossBps_ == 0 || maxLossBps_ > 500 || rebalanceCooldown_ < 1 hours
                || pokeDelay_ < rebalanceCooldown_
        ) revert InvalidParameters();
        rebalanceCooldown = rebalanceCooldown_;
        pokeDelay = pokeDelay_;
        maxLossBps = maxLossBps_;
        minPositionValueUsd = minPositionValueUsd_;
        minSwapValueUsd = minSwapValueUsd_;
        emit RebalanceParamsUpdated(
            rebalanceCooldown_, pokeDelay_, maxLossBps_, minPositionValueUsd_, minSwapValueUsd_
        );
    }

    function setRangeBounds(
        uint24 lowerWidthTicks_,
        uint24 upperWidthTicks_,
        uint24 maxWidthTicks_,
        int256 volatilityTicks_,
        uint24 driftNumerator_
    ) external onlyOwner {
        if (
            lowerWidthTicks_ == 0 || upperWidthTicks_ == 0 || lowerWidthTicks_ > maxWidthTicks_
                || upperWidthTicks_ > maxWidthTicks_ || maxWidthTicks_ < uint24(key.tickSpacing)
                || driftNumerator_ == 0 || driftNumerator_ > 1000
                || volatilityTicks_ > int256(uint256(maxWidthTicks_))
                || volatilityTicks_ < -int256(uint256(maxWidthTicks_))
        ) revert InvalidParameters();
        lowerWidthTicks = lowerWidthTicks_;
        upperWidthTicks = upperWidthTicks_;
        maxWidthTicks = maxWidthTicks_;
        volatilityTicks = volatilityTicks_;
        driftNumerator = driftNumerator_;
        emit RangeBoundsUpdated(lowerWidthTicks_, upperWidthTicks_, maxWidthTicks_, volatilityTicks_, driftNumerator_);
    }

    /// @notice Peg price and depeg-hold threshold for peg-centered
    /// vaults. The fixed band itself is deployment config (the
    /// constructor ticks); it is not adjustable here because the peg
    /// vault has no recenter path to apply a new band with.
    function setPegParams(
        uint256 pegPrice_,
        uint256 depegThresholdPrice_
    ) external onlyOwner {
        if (pegPrice_ == 0 || depegThresholdPrice_ == 0 || depegThresholdPrice_ >= pegPrice_) {
            revert InvalidParameters();
        }
        pegPrice = pegPrice_;
        depegThresholdPrice = depegThresholdPrice_;
        emit PegParamsUpdated(pegPrice_, depegThresholdPrice_);
    }

    /// @notice Expected-fees gate parameters (quality-bar point 3): the
    /// horizon expected fees are projected over, the minimum trailing
    /// window the fee estimate is measured on, and the margin the
    /// estimate must clear over the swap leg's cost (10_000 = 100%:
    /// expected fees must exceed 1.0x cost; 0 disables the gate).
    function setFeeGateParams(
        uint32 feeGateHorizon_,
        uint32 feeGateWindow_,
        uint32 feeGateMarginBps_
    ) external onlyOwner {
        if (
            feeGateHorizon_ < 1 hours || feeGateHorizon_ > 30 days || feeGateWindow_ < 1 minutes
                || feeGateWindow_ > 7 days || feeGateMarginBps_ > 100_000
        ) revert InvalidParameters();
        feeGateHorizon = feeGateHorizon_;
        feeGateWindow = feeGateWindow_;
        feeGateMarginBps = feeGateMarginBps_;
        emit FeeGateParamsUpdated(feeGateHorizon_, feeGateWindow_, feeGateMarginBps_);
    }

    // ------------------------------------------------------------------
    // Deposits / redemptions (v1 interface, ratio accounting per design
    // section 1.5: the first argument is shares to mint / burn; the
    // liquidity moved is shares * totalPositionLiquidity / totalSupply).
    // ------------------------------------------------------------------

    /// @notice Mint exactly shares share tokens, adding the pro-rata slice
    /// of the current position, subject to token input caps that include
    /// the new holder's contribution toward accrued fees.
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
        (uint256 limit0, uint256 limit1) = assetIsCurrency0 ? (levelLimit, usdcLimit) : (usdcLimit, levelLimit);
        Action memory action = Action(msg.sender, recipient, shares, limit0, limit1, isDeposit);
        (uint256 amount0, uint256 amount1) =
            abi.decode(manager.unlock(abi.encode(uint8(0), action)), (uint256, uint256));
        return assetIsCurrency0 ? (amount0, amount1) : (amount1, amount0);
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotPoolManager();
        uint8 tag = abi.decode(data, (uint8));
        if (tag == 0) {
            (, Action memory action) = abi.decode(data, (uint8, Action));
            (uint256 amount0, uint256 amount1) = action.deposit ? _deposit(action) : _redeem(action);
            return abi.encode(amount0, amount1);
        }
        (, RebalanceStep memory step) = abi.decode(data, (uint8, RebalanceStep));
        if (step.mint) _rebalanceMint(step);
        else _rebalanceRemove(step);
        return "";
    }

    function _deposit(
        Action memory action
    ) private returns (uint256 amount0, uint256 amount1) {
        _observeFeeGrowth();
        uint256 supply = totalSupply();
        if (supply != 0) _collectFees();
        return _mintLiquidity(action, supply);
    }

    function _mintLiquidity(
        Action memory action,
        uint256 supply
    ) private returns (uint256 amount0, uint256 amount1) {
        uint256 liquidity =
            supply == 0 ? action.shares : FullMath.mulDiv(action.shares, totalPositionLiquidity, supply);
        if (liquidity == 0 || liquidity > uint256(uint128(type(int128).max))) revert InvalidAmount();
        (BalanceDelta delta, BalanceDelta fees) = _modify(tickLower, tickUpper, int256(liquidity));
        if (fees.amount0() != 0 || fees.amount1() != 0) revert InvalidSettlement();
        totalPositionLiquidity += liquidity;

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

    /// @dev The official hook can add liquidity during its own swap callback
    /// without a second PoolManager unlock. Depositor and payer are the hook.
    function _depositBalancedFromHook(
        uint256 maxAsset,
        uint256 maxUsdc,
        address recipient
    ) internal returns (uint256 shares, uint256 assetIn, uint256 usdcIn) {
        if (msg.sender != address(key.hooks) || recipient == address(0)) revert NotPoolManager();
        (uint256 max0, uint256 max1) = assetIsCurrency0 ? (maxAsset, maxUsdc) : (maxUsdc, maxAsset);
        _observeFeeGrowth();
        uint256 supply = totalSupply();
        if (supply != 0) _collectFees();
        shares = _availableShares(max0, max1, supply);
        if (shares == 0) revert InvalidAmount();
        (uint256 amount0, uint256 amount1) =
            _mintLiquidity(Action(msg.sender, recipient, shares, max0, max1, true), supply);
        (assetIn, usdcIn) = assetIsCurrency0 ? (amount0, amount1) : (amount1, amount0);
        emit LiquidityDeposited(msg.sender, recipient, shares, assetIn, usdcIn);
    }

    /// @notice Largest share amount whose pro-rata liquidity (plus the
    /// fee-reserve equalization payment) fits within the token caps.
    function _availableShares(
        uint256 max0,
        uint256 max1,
        uint256 supply
    ) private view returns (uint256 low) {
        (uint160 price,,,) = manager.getSlot0(key.toId());
        uint160 lower = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 upper = TickMath.getSqrtPriceAtTick(tickUpper);
        uint256 maxLiquidity = LiquidityAmounts.getLiquidityForAmounts(price, lower, upper, max0, max1);
        uint256 high = supply == 0 ? maxLiquidity : FullMath.mulDiv(maxLiquidity, supply, totalPositionLiquidity);
        if (high > uint256(uint128(type(int128).max))) high = uint256(uint128(type(int128).max));

        // The usual case has no collected fee reserves. Its principal-only
        // quote already includes the same rounding as settlement.
        if (feeReserve0 == 0 && feeReserve1 == 0) return high;
        uint160 start0 = price > lower ? price : lower;
        uint160 end1 = price < upper ? price : upper;
        while (low < high) {
            uint256 mid = low + (high - low + 1) / 2;
            uint128 liquidity = uint128(FullMath.mulDiv(mid, totalPositionLiquidity, supply));
            uint256 amount0 = start0 < upper ? SqrtPriceMath.getAmount0Delta(start0, upper, liquidity, true) : 0;
            uint256 amount1 = end1 > lower ? SqrtPriceMath.getAmount1Delta(lower, end1, liquidity, true) : 0;
            amount0 += FullMath.mulDivRoundingUp(feeReserve0, mid, supply);
            amount1 += FullMath.mulDivRoundingUp(feeReserve1, mid, supply);
            if (amount0 <= max0 && amount1 <= max1) low = mid;
            else high = mid - 1;
        }
    }

    function _redeem(
        Action memory action
    ) private returns (uint256 amount0, uint256 amount1) {
        uint256 supply = totalSupply();
        _burn(action.payer, action.shares);
        uint256 liquidity = FullMath.mulDiv(action.shares, totalPositionLiquidity, supply);
        (BalanceDelta delta, BalanceDelta fees) = _modify(tickLower, tickUpper, -int256(liquidity));
        totalPositionLiquidity -= liquidity;
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
        _collectFeesAt(tickLower, tickUpper);
    }

    function _collectFeesAt(
        int24 lower,
        int24 upper
    ) private {
        (BalanceDelta delta, BalanceDelta fees) = _modify(lower, upper, 0);
        if (BalanceDelta.unwrap(delta) != BalanceDelta.unwrap(fees)) revert InvalidSettlement();
        uint256 amount0 = _positive(delta.amount0());
        uint256 amount1 = _positive(delta.amount1());
        feeReserve0 += amount0;
        feeReserve1 += amount1;
        _take(key.currency0, amount0);
        _take(key.currency1, amount1);
        _observeFeeGrowth();
    }

    /// @dev Maintain the expected-fees gate's observation pair. The
    /// snapshots are the pool's cumulative fee-growth globals
    /// (StateLibrary.getFeeGrowthGlobals: Q128 fee growth per unit of
    /// liquidity, per currency), readable on-chain for any position
    /// size. "last" is refreshed on every observation (deposits and
    /// fee collections, including the rebalance's own removal — no
    /// keeper duty); when a refresh finds the previous "last" at
    /// least feeGateWindow old, that aged snapshot is promoted to
    /// "prev" first. The pair therefore always spans at least the
    /// configured window, and "prev" is the freshest snapshot that
    /// had aged a full window when a newer one arrived.
    function _observeFeeGrowth() private {
        (uint256 growth0, uint256 growth1) = manager.getFeeGrowthGlobals(poolId);
        if (feeGateLastAt != 0 && block.timestamp >= feeGateLastAt + feeGateWindow) {
            feeGatePrevGrowth0 = feeGateLastGrowth0;
            feeGatePrevGrowth1 = feeGateLastGrowth1;
            feeGatePrevAt = feeGateLastAt;
        }
        feeGateLastGrowth0 = growth0;
        feeGateLastGrowth1 = growth1;
        feeGateLastAt = block.timestamp;
    }

    function _modify(
        int24 lower,
        int24 upper,
        int256 change
    ) private returns (BalanceDelta delta, BalanceDelta fees) {
        return manager.modifyLiquidity(key, ModifyLiquidityParams(lower, upper, change, bytes32(0)), "");
    }

    // ------------------------------------------------------------------
    // Auto-range rebalance (design sections 1.2-1.3, 3). One transaction:
    // sequential guard quote / remove / swap / re-mint unlocks, so any
    // revert anywhere restores the exact prior position (section 1.6).
    // ------------------------------------------------------------------

    /// @notice Keeper entry point. Parameterless by design: the keeper
    /// decides when; the contract decides where and how much. The keeper
    /// cannot pick a range, a recipient, or a size, and receives nothing.
    function rebalance() external nonReentrant {
        if (!keepers[msg.sender]) revert NotKeeper();
        _rebalance(false);
    }

    /// @notice Permissionless fallback: anyone may rebalance once the
    /// position has been eligible-and-unserviced for pokeDelay, so a dead
    /// keeper can never strand the position out of range.
    function pokeRebalance() external nonReentrant {
        _rebalance(true);
    }

    /// @notice Keeper view. Reason codes (design section 1.2): 0 = not
    /// eligible, 1 = eligible (spot tick at/outside the live band),
    /// 2 = eligible (an edge drifted at/past its per-side threshold),
    /// 3 = cooldown,
    /// 4 = oracle invalid, 5 = defense active, 6 = Genesis gate closed,
    /// 7 = position below minimum value, 8 = depeg hold (peg-centered
    /// vaults), 9 = no valid target range exists. Note: the defense leg
    /// reads the defense contract's last-synced state; rebalance() itself
    /// syncs for ground truth.
    function rebalanceNeeded() external view returns (bool eligible, uint8 reason) {
        if (lastRebalanceAt != 0 && block.timestamp < lastRebalanceAt + rebalanceCooldown) return (false, 3);
        if (address(schedule) != address(0) && block.timestamp < schedule.end()) return (false, 6);
        if (address(defense) != address(0) && defense.active()) return (false, 5);
        (uint256 twap,, bool valid) = oracle.latestValidatedTwap();
        if (!valid || twap == 0) return (false, 4);
        if (pegCentered && twap < depegThresholdPrice) return (false, 8);
        if (totalPositionLiquidity == 0) return (false, 7);
        uint160 twapSqrt = MasonryLevelPrice.sqrtPriceFromPrice(twap, assetIsCurrency0);
        (uint256 pos0, uint256 pos1) = _amountsForLiquidity(twapSqrt, tickLower, tickUpper, totalPositionLiquidity);
        if (_valueUsd(pos0, pos1, twap) < minPositionValueUsd) return (false, 7);
        int24 twapTick = MasonryLevelPrice.tickFromPrice(twap, assetIsCurrency0);
        (uint160 spotSqrt,,,) = manager.getSlot0(poolId);
        int24 spotTick = TickMath.getTickAtSqrtPrice(spotSqrt);
        uint8 assessed;
        (assessed,,,) = _assess(twapTick, spotTick);
        if (assessed == 1 || assessed == 2) return (true, assessed);
        return (false, assessed);
    }

    /// @notice The band the vault currently targets, and the center
    /// tick it uses (the TWAP tick, or the fixed live band for
    /// peg-centered vaults). Returns the current range when the oracle
    /// is invalid.
    function suggestedRange() external view returns (int24 lower, int24 upper, int24 centerTick) {
        (uint256 twap,, bool valid) = oracle.latestValidatedTwap();
        if (!valid || twap == 0) return (tickLower, tickUpper, 0);
        int24 twapTick = MasonryLevelPrice.tickFromPrice(twap, assetIsCurrency0);
        if (pegCentered) {
            return (
                tickLower,
                tickUpper,
                _alignTick(
                    MasonryLevelPrice.tickFromPrice(pegPrice, assetIsCurrency0), (tickLower + tickUpper) / 2
                )
            );
        }
        (int24 tL, int24 tU,,,) = _targetBand(twapTick);
        return (tL, tU, twapTick);
    }

    function currentTwapTick() external view returns (int24 tick, uint256 observedAt, bool valid) {
        (uint256 price, uint256 at, bool ok) = oracle.latestValidatedTwap();
        valid = ok && price != 0;
        return (valid ? MasonryLevelPrice.tickFromPrice(price, assetIsCurrency0) : int24(0), at, valid);
    }

    function _rebalance(
        bool poked
    ) private {
        if (lastRebalanceAt != 0) {
            uint256 earliest = lastRebalanceAt + (poked ? pokeDelay : rebalanceCooldown);
            if (block.timestamp < earliest) revert CooldownActive(earliest);
        }
        // Genesis gate: the schedule reference is read live (its end() is
        // 0 while unscheduled, which does not block; once scheduled it
        // blocks until Genesis ends). Peg-centered launch vaults pass
        // their hook's schedule; other vaults pass the zero address.
        if (address(schedule) != address(0)) {
            uint256 end = schedule.end();
            if (block.timestamp < end) revert GenesisLocked(end);
        }
        // Critical Defense gate, synced for ground truth.
        if (address(defense) != address(0) && defense.sync()) revert DefenseActive();

        (uint256 twap,, bool valid) = oracle.latestValidatedTwap();
        if (!valid || twap == 0) revert OracleInvalid();
        int24 twapTick = MasonryLevelPrice.tickFromPrice(twap, assetIsCurrency0);
        // Peg-centered vaults never chase a depeg: below the threshold the
        // position holds its peg band as deployed defense capital.
        if (pegCentered && twap < depegThresholdPrice) revert DepegHold();
        // Conflicting-feed check: spot must agree with the TWAP inside the
        // guard's tolerance and pool liquidity must be sufficient, or the
        // rebalance fails closed before touching the position.
        guard.validatedSpot();

        RebalanceRun memory run;
        run.twap = twap;
        run.twapTick = twapTick;
        uint256 liquidityBefore = totalPositionLiquidity;
        if (liquidityBefore == 0) revert PositionTooSmall();
        {
            uint160 twapSqrt = MasonryLevelPrice.sqrtPriceFromPrice(twap, assetIsCurrency0);
            (uint256 pos0, uint256 pos1) = _amountsForLiquidity(twapSqrt, tickLower, tickUpper, liquidityBefore);
            run.valueBefore = _valueUsd(pos0, pos1, twap);
        }
        // Dust positions never rebalance (design 6.5); checked before
        // eligibility so the view and the action agree on reason 7.
        if (run.valueBefore < minPositionValueUsd) revert PositionTooSmall();
        (uint160 spotSqrt,,,) = manager.getSlot0(poolId);
        int24 spotTick = TickMath.getTickAtSqrtPrice(spotSqrt);
        uint8 reason;
        (reason, run.newLower, run.newUpper,) = _assess(twapTick, spotTick);
        if (reason == 9) revert RangeClamp();
        if (reason != 1 && reason != 2) revert NotEligible();

        _executeRebalance(run, liquidityBefore);
    }

    function _executeRebalance(
        RebalanceRun memory run,
        uint256 liquidityBefore
    ) private {
        // run.valueBefore was computed and min-checked by the caller.
        uint160 twapSqrt = MasonryLevelPrice.sqrtPriceFromPrice(run.twap, assetIsCurrency0);
        run.oldLower = tickLower;
        run.oldUpper = tickUpper;

        // Collect fees and remove the whole position (one unlock).
        manager.unlock(abi.encode(uint8(1), RebalanceStep(run.oldLower, run.oldUpper, liquidityBefore, false)));
        run.bal0 = _rbAmount0;
        run.bal1 = _rbAmount1;

        _swapLeg(run);

        // Re-mint at the new range with whatever the post-swap balances
        // support at the (post-swap) spot price.
        {
            (uint160 spotSqrt,,,) = manager.getSlot0(poolId);
            run.newLiquidity = LiquidityAmounts.getLiquidityForAmounts(
                spotSqrt,
                TickMath.getSqrtPriceAtTick(run.newLower),
                TickMath.getSqrtPriceAtTick(run.newUpper),
                run.bal0,
                run.bal1
            );
        }
        if (run.newLiquidity == 0 || run.newLiquidity > uint256(uint128(type(int128).max))) {
            revert PositionTooSmall();
        }
        manager.unlock(abi.encode(uint8(1), RebalanceStep(run.newLower, run.newUpper, run.newLiquidity, true)));

        // Loss cap: value after (new position + uninvested dust, both at
        // the same TWAP) against value before. A breach reverts the whole
        // transaction, restoring the old position untouched.
        {
            (uint256 np0, uint256 np1) =
                _amountsForLiquidity(twapSqrt, run.newLower, run.newUpper, run.newLiquidity);
            run.valueAfter = _valueUsd(np0 + (run.bal0 - _rbPaid0), np1 + (run.bal1 - _rbPaid1), run.twap);
        }
        if (run.valueAfter * 10_000 < run.valueBefore * (10_000 - maxLossBps)) revert LossCapExceeded();

        tickLower = run.newLower;
        tickUpper = run.newUpper;
        totalPositionLiquidity = run.newLiquidity;
        lastRebalanceAt = block.timestamp;
        emit Rebalanced(
            poolId,
            run.oldLower,
            run.oldUpper,
            run.newLower,
            run.newUpper,
            run.twapTick,
            liquidityBefore,
            run.newLiquidity,
            run.soldAsset,
            run.boughtAsset,
            run.valueBefore,
            run.valueAfter,
            msg.sender
        );
    }

    /// @dev Swap the removed balances toward the new range's ratio at spot.
    /// Only the excess side moves, and only when its TWAP value clears the
    /// dust threshold. Selling the asset pays the real Fire Tax through
    /// the hook (no keeper exemption); the guard's minimums bound the
    /// execution. Any guard/router revert aborts the whole rebalance.
    function _swapLeg(
        RebalanceRun memory run
    ) private {
        (uint160 spotSqrt,,,) = manager.getSlot0(poolId);
        uint160 lowerSqrt = TickMath.getSqrtPriceAtTick(run.newLower);
        uint160 upperSqrt = TickMath.getSqrtPriceAtTick(run.newUpper);
        uint128 spotTarget =
            LiquidityAmounts.getLiquidityForAmounts(spotSqrt, lowerSqrt, upperSqrt, run.bal0, run.bal1);
        uint256 req0;
        uint256 req1;
        if (spotTarget > 0) {
            (req0, req1) = _amountsForLiquidity(spotSqrt, run.newLower, run.newUpper, spotTarget);
        } else {
            // Single-sided balances (a full range exit removed a position
            // holding only one currency): getLiquidityForAmounts returns
            // 0, which would sell 100% of the held side and re-mint
            // nothing. Derive the target from total TWAP value instead.
            (uint256 unit0, uint256 unit1) = _amountsForLiquidity(spotSqrt, run.newLower, run.newUpper, 1e18);
            if (unit0 == 0 || unit1 == 0) return; // spot outside the new range: mint single-sided
            uint256 unitValue = _valueUsd(unit0, unit1, run.twap);
            if (unitValue == 0) return;
            uint256 targetLiquidity = FullMath.mulDiv(_valueUsd(run.bal0, run.bal1, run.twap), 1e18, unitValue);
            req0 = FullMath.mulDiv(unit0, targetLiquidity, 1e18);
            req1 = FullMath.mulDiv(unit1, targetLiquidity, 1e18);
        }
        // Pick the side to sell by TWAP value of its excess. The
        // binding side's balance sits a rounding hair above its
        // requirement (getLiquidityForAmounts floors the target
        // liquidity, the amounts are then recomputed rounded down), so
        // testing currency0 first would let that dust excess mask a
        // position-sized excess on the other side: the leg would be
        // skipped as dust and the fat side stranded as an uninvested
        // vault balance the ratio accounting cannot redeem.
        uint256 excess0 = run.bal0 > req0 ? run.bal0 - req0 : 0;
        uint256 excess1 = run.bal1 > req1 ? run.bal1 - req1 : 0;
        if (excess0 == 0 && excess1 == 0) return;
        bool sellCurrency0 = _valueUsd(excess0, 0, run.twap) >= _valueUsd(0, excess1, run.twap);
        uint256 excess = sellCurrency0 ? excess0 : excess1;
        bool sellAsset = sellCurrency0 == assetIsCurrency0;
        uint256 excessValue = sellAsset ? FullMath.mulDiv(excess, run.twap, 1e18) : excess * 1e12;
        if (excessValue < minSwapValueUsd) return;
        uint256 amountOut;
        if (sellAsset) {
            uint256 minimum = guard.minimumAssetSaleOut(excess);
            _enforceFeeGate(run.twap, excessValue, true, minimum);
            amountOut = _routerSwap(sellCurrency0, excess, minimum);
            run.soldAsset = true;
        } else {
            uint256 minimum = guard.minimumLevelOut(excess);
            _enforceFeeGate(run.twap, excessValue, false, minimum);
            amountOut = _routerSwap(sellCurrency0, excess, minimum);
            run.boughtAsset = true;
        }
        if (sellCurrency0) {
            run.bal0 -= excess;
            run.bal1 += amountOut;
        } else {
            run.bal1 -= excess;
            run.bal0 += amountOut;
        }
    }

    /// @notice Expected fee earnings of a position of the current size
    /// over feeGateHorizon, in 1e18-scale USD at the given TWAP.
    /// @dev Estimator (quality-bar point 3): the pool's fee-growth
    /// globals are cumulative fees per unit of liquidity, so the delta
    /// between the vault's two snapshots, times the CURRENT position
    /// liquidity, is the fee amount a position of exactly this size
    /// earned over the trailing window the snapshots span; scaling by
    /// horizon / span projects that rate over the horizon. Both
    /// snapshots are valued at the current TWAP. Documented
    /// assumptions: (1) pool fee volume per unit of liquidity persists
    /// at its trailing-window rate; (2) the recentered position stays
    /// in range for roughly the same share of the horizon as the
    /// pool's average liquidity did during the window. The margin
    /// parameter is the safety factor on top of these. With no
    /// completed observation pair the estimate is 0 — fail closed: a
    /// rebalance whose swap leg costs anything is refused until the
    /// vault has a full window of fee history.
    function _expectedFeesUsd(
        uint256 twap
    ) private view returns (uint256) {
        if (feeGatePrevAt == 0 || feeGateLastAt <= feeGatePrevAt || totalPositionLiquidity == 0) return 0;
        uint256 span = feeGateLastAt - feeGatePrevAt;
        uint256 fees0 =
            FullMath.mulDiv(feeGateLastGrowth0 - feeGatePrevGrowth0, totalPositionLiquidity, 1 << 128);
        uint256 fees1 =
            FullMath.mulDiv(feeGateLastGrowth1 - feeGatePrevGrowth1, totalPositionLiquidity, 1 << 128);
        uint256 windowFeesUsd = _valueUsd(fees0, fees1, twap);
        return FullMath.mulDiv(windowFeesUsd, feeGateHorizon, span);
    }

    /// @dev The expected-fees side of the rebalance cost test
    /// (quality-bar point 3). The leg's cost is priced from the same
    /// guard machinery the loss cap relies on: the guard's minimum out
    /// is a previewed execution quote (it runs a real swap internally
    /// and enforces TWAP-denominated execution loss before reverting
    /// it), so cost = TWAP value paid in minus the TWAP value of that
    /// minimum out — swap fees, Fire Tax and price impact included.
    /// Refusal is a revert here, inside the rebalance's first swap
    /// step, so the whole rebalance rolls back and the position is
    /// untouched. Legs that never reach this function — dust below
    /// minSwapValueUsd, or balances already at the target ratio — move
    /// no value through a swap and carry no leg cost to cover.
    function _enforceFeeGate(
        uint256 twap,
        uint256 paidValueUsd,
        bool sellAsset,
        uint256 minimumOut
    ) private view {
        if (feeGateMarginBps == 0) return;
        uint256 receivedValueUsd =
            sellAsset ? minimumOut * 1e12 : FullMath.mulDiv(minimumOut, twap, 1e18);
        uint256 costUsd = paidValueUsd > receivedValueUsd ? paidValueUsd - receivedValueUsd : 0;
        uint256 expected = _expectedFeesUsd(twap);
        uint256 required = FullMath.mulDiv(costUsd, feeGateMarginBps, 10_000);
        if (expected <= required) revert NotCostEffective(expected, required);
    }

    function _routerSwap(
        bool zeroForOne,
        uint256 amountIn,
        uint256 amountOutMin
    ) private returns (uint256 amountOut) {
        IERC20 tokenIn = IERC20(Currency.unwrap(zeroForOne ? key.currency0 : key.currency1));
        tokenIn.forceApprove(address(router), amountIn);
        amountOut = router.swapExactIn(key, zeroForOne, amountIn, amountOutMin, address(this));
        tokenIn.forceApprove(address(router), 0);
    }

    function _rebalanceRemove(
        RebalanceStep memory step
    ) private {
        _collectFeesAt(step.lower, step.upper);
        (BalanceDelta delta, BalanceDelta fees) = _modify(step.lower, step.upper, -int256(step.liquidity));
        if (fees.amount0() != 0 || fees.amount1() != 0) revert InvalidSettlement();
        uint256 amount0 = _positive(delta.amount0());
        uint256 amount1 = _positive(delta.amount1());
        _take(key.currency0, amount0);
        _take(key.currency1, amount1);
        _rbAmount0 = amount0;
        _rbAmount1 = amount1;
    }

    function _rebalanceMint(
        RebalanceStep memory step
    ) private {
        (BalanceDelta delta, BalanceDelta fees) = _modify(step.lower, step.upper, int256(step.liquidity));
        if (fees.amount0() != 0 || fees.amount1() != 0) revert InvalidSettlement();
        uint256 owed0 = _positive(-int256(delta.amount0()));
        uint256 owed1 = _positive(-int256(delta.amount1()));
        _paySelf(key.currency0, owed0);
        _paySelf(key.currency1, owed1);
        _rbPaid0 = owed0;
        _rbPaid1 = owed1;
    }

    /// @dev Eligibility + target range for the current state. Reason 0 =
    /// not eligible, 1 = eligible, 2 = eligible near an edge (TWAP mode
    /// only), 9 = no valid target range (clamp/settle impossible).
    function _assess(
        int24 twapTick,
        int24 spotTick
    ) private view returns (uint8 reason, int24 newLower, int24 newUpper, int24 centerTick) {
        if (pegCentered) {
            // FIXED BAND — NO RECENTER PATH (specs section 2, Jess
            // 2026-11-08 22:05 EST): the peg vault's band is set at
            // deployment (widths config, default $0.82-$1.10) and never
            // follows price. The target is always the live ticks, so
            // eligibility never fires at any spot or TWAP; recentering
            // machinery exists only for price-following (TWAP) vaults.
            // The depeg hold is enforced by the caller before this.
            centerTick =
                _alignTick(MasonryLevelPrice.tickFromPrice(pegPrice, assetIsCurrency0), (tickLower + tickUpper) / 2);
            return (0, tickLower, tickUpper, centerTick);
        }
        // Price-following mode: the EXACT recenter trigger (Jess
        // 2026-11-08 22:06 EST, from the test-passing
        // needsRecenterToTarget). Everything is in tick units; the
        // center is the TWAP tick (bar point 2: never spot), and the
        // spot tick is used only inside the trigger, after the caller's
        // TWAP-deviation guard has validated it.
        centerTick = twapTick;
        (int24 tL, int24 tU, uint24 lw, uint24 uw, bool ok) = _targetBand(twapTick);
        if (!ok) return (9, tickLower, tickUpper, centerTick);
        // (1) Target ticks == live ticks: never fire. This equality
        // skip is what kills the old trigger's every-cooldown churn.
        if (tL == tickLower && tU == tickUpper) return (0, tickLower, tickUpper, centerTick);
        // (2) Spot tick at or outside either live edge: fire.
        if (spotTick <= tickLower || spotTick >= tickUpper) return (1, tL, tU, centerTick);
        // (3) Fire only when an edge has drifted from its target by at
        // least the per-side threshold: the clamped spot's span to that
        // target edge, scaled by driftNumerator / that side's width,
        // minimum 1 tick (integer division, per the reference). The
        // denominators are the SAME widths the band was built with.
        int24 t = spotTick;
        if (t < tL) t = tL;
        if (t > tU) t = tU;
        uint256 spanL = uint256(int256(t) - int256(tL));
        uint256 spanU = uint256(int256(tU) - int256(t));
        uint256 thrL = spanL * driftNumerator / lw;
        uint256 thrU = spanU * driftNumerator / uw;
        if (thrL == 0) thrL = 1;
        if (thrU == 0) thrU = 1;
        if (_edgeDrift(tL, tickLower) >= thrL || _edgeDrift(tU, tickUpper) >= thrU) {
            return (2, tL, tU, centerTick);
        }
        return (0, tickLower, tickUpper, centerTick);
    }

    function _edgeDrift(
        int24 a,
        int24 b
    ) private pure returns (uint256) {
        int256 d = int256(a) - int256(b);
        return uint256(d < 0 ? -d : d);
    }

    /// @dev The band the price-following mode targets: the TWAP tick as
    /// center, SEPARATE asymmetric widths per side (never one symmetric
    /// width), edges snapped to tick spacing. Also returns the
    /// effective widths so the trigger thresholds are computed from the
    /// identical parameters the band was constructed with.
    function _targetBand(
        int24 twapTick
    ) private view returns (int24 tL, int24 tU, uint24 lw, uint24 uw, bool ok) {
        (lw, uw) = _effectiveWidths();
        tL = _alignTick(twapTick - int24(lw), twapTick);
        tU = _alignTick(twapTick + int24(uw), twapTick);
        ok = tL >= TickMath.MIN_TICK && tU <= TickMath.MAX_TICK && tL < tU;
    }

    function _effectiveWidths() private view returns (uint24 lw, uint24 uw) {
        int256 spacing = int256(key.tickSpacing);
        int256 cap = int256(uint256(maxWidthTicks));
        int256 lo = int256(uint256(lowerWidthTicks)) + volatilityTicks;
        int256 hi = int256(uint256(upperWidthTicks)) + volatilityTicks;
        if (lo < spacing) lo = spacing;
        if (hi < spacing) hi = spacing;
        if (lo > cap) lo = cap;
        if (hi > cap) hi = cap;
        lw = uint24(uint256(lo));
        uw = uint24(uint256(hi));
    }

    /// @dev Base half-width adjusted by the owner-set volatility input,
    /// clamped to [settleMargin + 1, maxHalfWidth] and rounded to the
    /// pool's tick spacing so range bounds stay spacing-aligned.

    /// @dev Round a tick to the nearest tick-spacing multiple; exact ties
    /// resolve toward tieToward (the current range center), so repeated
    /// assessments cannot flip-flop between two adjacent centers.
    function _alignTick(
        int24 tick,
        int24 tieToward
    ) private view returns (int24) {
        int24 spacing = key.tickSpacing;
        int24 base = tick / spacing * spacing;
        int24 rem = tick - base;
        if (rem == 0) return tick;
        int24 step = rem > 0 ? spacing : -spacing;
        int24 absRem = rem > 0 ? rem : -rem;
        if (absRem * 2 > spacing) return base + step;
        if (absRem * 2 < spacing) return base;
        int24 other = base + step;
        int24 distBase = tieToward > base ? tieToward - base : base - tieToward;
        int24 distOther = tieToward > other ? tieToward - other : other - tieToward;
        return distOther < distBase ? other : base;
    }

    /// @dev Token amounts backing a liquidity position at a given price,
    /// computed with SqrtPriceMath deltas over the clamped sub-ranges —
    /// the same construction the v1 vault uses in _availableShares. (The
    /// pinned v4-periphery LiquidityAmounts exports no
    /// getAmountsForLiquidity; the design document's reference to it is
    /// satisfied by this equivalent.)
    function _amountsForLiquidity(
        uint160 sqrtPrice,
        int24 lower,
        int24 upper,
        uint256 liquidity
    ) private pure returns (uint256 amount0, uint256 amount1) {
        uint160 lowerSqrt = TickMath.getSqrtPriceAtTick(lower);
        uint160 upperSqrt = TickMath.getSqrtPriceAtTick(upper);
        uint128 liq = uint128(liquidity);
        uint160 start0 = sqrtPrice > lowerSqrt ? sqrtPrice : lowerSqrt;
        uint160 end1 = sqrtPrice < upperSqrt ? sqrtPrice : upperSqrt;
        amount0 = start0 < upperSqrt ? SqrtPriceMath.getAmount0Delta(start0, upperSqrt, liq, false) : 0;
        amount1 = end1 > lowerSqrt ? SqrtPriceMath.getAmount1Delta(lowerSqrt, end1, liq, false) : 0;
    }

    /// @dev TWAP-denominated position value in 1e18-scale USD. The asset
    /// is 18 decimals and the stable 6 (both enforced by the hook), so a
    /// stable amount scales by 1e12.
    function _valueUsd(
        uint256 amount0,
        uint256 amount1,
        uint256 twap
    ) private view returns (uint256) {
        (uint256 assetAmount, uint256 usdcAmount) = assetIsCurrency0 ? (amount0, amount1) : (amount1, amount0);
        return FullMath.mulDiv(assetAmount, twap, 1e18) + usdcAmount * 1e12;
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

    /// @dev Settle a PoolManager debt from the vault's own balance (the
    /// rebalance re-mint leg pays with tokens the vault itself holds).
    function _paySelf(
        Currency currency,
        uint256 amount
    ) private {
        if (amount == 0) return;
        IERC20 token = IERC20(Currency.unwrap(currency));
        manager.sync(currency);
        token.safeTransfer(address(manager), amount);
        if (manager.settle() != amount) revert InvalidSettlement();
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

contract MasonryLevelUsdcVault is MasonryUsdcVault {
    constructor(
        PoolKey memory pool,
        int24 lower,
        int24 upper,
        MasonryBuybackGuard guard_,
        MiniSwapRouter router_,
        MasonryCriticalDefense defense_,
        address owner_
    )
        MasonryUsdcVault(
            pool,
            lower,
            upper,
            "Masonry LEVEL/USDC LP",
            "mLEVEL-USDC",
            guard_,
            router_,
            defense_,
            MasonryLevelHook(address(pool.hooks)).schedule(),
            true,
            1800,
            1000,
            owner_
        )
    {
        MasonryLevelHook hook = MasonryLevelHook(address(pool.hooks));
        if (hook.level() != hook.asset()) revert InvalidConfiguration();
    }

    function levelIsCurrency0() external view returns (bool) {
        return assetIsCurrency0;
    }
}
