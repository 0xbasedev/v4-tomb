// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {IMasonryPolSink, IMasonryRangeNudge} from "./IMasonryPolSink.sol";
import {MasonryRangeLib} from "./MasonryRangeLib.sol";
import {MasonryLevelPrice} from "./MasonryLevelPrice.sol";

interface IMasonryRangeTwap {
    function latestValidatedTwap() external view returns (uint256 price, uint256 observedAt, bool valid);
}

/// @notice Protocol-owned concentrated Uniswap v4 position that recenters with price.
/// @dev No admin withdrawal. Idle leftovers stay here until they can be deployed.
contract MasonryRangeManager is ReentrancyGuard, IUnlockCallback, IMasonryPolSink, IMasonryRangeNudge {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;


    enum Op {
        Fund,
        Rebalance
    }

    IPoolManager public immutable override manager;
    IMasonryRangeTwap public immutable twapOracle;
    address public immutable override hook;
    PoolId public immutable poolId;
    bool public immutable assetIsCurrency0;
    uint16 public immutable halfWidthBps;
    uint16 public immutable lowerHalfWidthBps;
    uint16 public immutable upperHalfWidthBps;
    uint160 public immutable sqrtPeg;
    bool public immutable pegAnchor;
    uint16 public immutable recenterBps;
    uint256 public immutable cooldown;
    uint16 public immutable maxTwapDeviationBps;
    uint128 public immutable minPoolLiquidity;

    PoolKey private key;
    int24 public override tickLower;
    int24 public override tickUpper;
    uint128 public liquidity;
    bool public seeded;
    uint256 public lastRebalanceAt;
    uint256 public lastRebalanceBlock;

    struct RangeConfig {
        uint16 halfWidthBps;
        uint16 recenterBps;
        uint256 cooldown;
        uint16 maxTwapDeviationBps;
        uint128 minPoolLiquidity;
        uint16 lowerHalfWidthBps;
        uint16 upperHalfWidthBps;
        uint160 sqrtPeg;
        bool pegAnchor;
    }

    error Unauthorized();
    error NotPoolManager();
    error UnsafeRebalance();
    error SlippageExceeded();
    error NoRecenterNeeded();
    error SameBlockRebalance();
    error CooldownActive();
    error ThinPool();
    error InvalidRecipient();

    event RangeSeeded(int24 tickLower, int24 tickUpper, uint128 liquidity);
    event RangeRebalanced(
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        int24 tick,
        uint256 principal0,
        uint256 principal1,
        uint256 fees0,
        uint256 fees1,
        int256 swap0,
        int256 swap1
    );
    event RangeFunded(uint128 added, uint256 amount0, uint256 amount1);

    constructor(
        IPoolManager manager_,
        PoolKey memory pool,
        IMasonryRangeTwap twapOracle_,
        address hook_,
        bool assetIsCurrency0_,
        RangeConfig memory cfg
    ) {
        if (cfg.pegAnchor) {
            if (
                cfg.sqrtPeg == 0 || cfg.lowerHalfWidthBps < 500 || cfg.upperHalfWidthBps < 500
                    || cfg.lowerHalfWidthBps > 3000 || cfg.upperHalfWidthBps > 3000
            ) {
                revert MasonryRangeLib.InvalidRangeConfig();
            }
            uint16 tighter = cfg.lowerHalfWidthBps < cfg.upperHalfWidthBps
                ? cfg.lowerHalfWidthBps
                : cfg.upperHalfWidthBps;
            MasonryRangeLib.validate(tighter, cfg.recenterBps, cfg.cooldown, cfg.maxTwapDeviationBps);
            halfWidthBps = cfg.lowerHalfWidthBps > cfg.upperHalfWidthBps
                ? cfg.lowerHalfWidthBps
                : cfg.upperHalfWidthBps;
            lowerHalfWidthBps = cfg.lowerHalfWidthBps;
            upperHalfWidthBps = cfg.upperHalfWidthBps;
            sqrtPeg = cfg.sqrtPeg;
        } else {
            MasonryRangeLib.validate(cfg.halfWidthBps, cfg.recenterBps, cfg.cooldown, cfg.maxTwapDeviationBps);
            halfWidthBps = cfg.halfWidthBps;
            lowerHalfWidthBps = cfg.halfWidthBps;
            upperHalfWidthBps = cfg.halfWidthBps;
            sqrtPeg = 0;
        }
        if (address(manager_) == address(0) || address(twapOracle_) == address(0) || cfg.minPoolLiquidity == 0) {
            revert MasonryRangeLib.InvalidRangeConfig();
        }
        manager = manager_;
        key = pool;
        poolId = pool.toId();
        twapOracle = twapOracle_;
        hook = hook_;
        assetIsCurrency0 = assetIsCurrency0_;
        pegAnchor = cfg.pegAnchor;
        recenterBps = cfg.recenterBps;
        cooldown = cfg.cooldown;
        maxTwapDeviationBps = cfg.maxTwapDeviationBps;
        minPoolLiquidity = cfg.minPoolLiquidity;
    }

    function poolKey() external view override returns (PoolKey memory) {
        return key;
    }

    function donate(
        uint256 maxAsset,
        uint256 maxQuote
    ) external nonReentrant {
        _pull(msg.sender, maxAsset, maxQuote);
        _run(Op.Fund);
    }

    function depositFromHook(
        uint256 maxAsset,
        uint256 maxQuote,
        address recipient
    ) external override nonReentrant returns (uint256 shares, uint256 assetIn, uint256 quoteIn) {
        if (msg.sender != hook) revert Unauthorized();
        if (recipient == address(0)) revert InvalidRecipient();
        IERC20 token0 = IERC20(Currency.unwrap(key.currency0));
        IERC20 token1 = IERC20(Currency.unwrap(key.currency1));
        uint256 before0 = token0.balanceOf(address(this));
        uint256 before1 = token1.balanceOf(address(this));
        (uint256 pull0, uint256 pull1) = assetIsCurrency0 ? (maxAsset, maxQuote) : (maxQuote, maxAsset);
        _pullRaw(msg.sender, pull0, pull1);
        _run(Op.Fund);
        uint256 after0 = token0.balanceOf(address(this));
        uint256 after1 = token1.balanceOf(address(this));
        uint256 refund0 = after0 > before0 ? after0 - before0 : 0;
        uint256 refund1 = after1 > before1 ? after1 - before1 : 0;
        if (refund0 > pull0) refund0 = pull0;
        if (refund1 > pull1) refund1 = pull1;
        if (refund0 != 0) token0.safeTransfer(msg.sender, refund0);
        if (refund1 != 0) token1.safeTransfer(msg.sender, refund1);
        uint256 used0 = pull0 - refund0;
        uint256 used1 = pull1 - refund1;
        shares = liquidity;
        (assetIn, quoteIn) = assetIsCurrency0 ? (used0, used1) : (used1, used0);
    }

    function rebalance() external nonReentrant {
        _requireSafeToMove();
        if (!shouldRebalance()) revert NoRecenterNeeded();
        _run(Op.Rebalance);
    }

    /// @notice Keeper/hook entry that never reverts on a no-op or safety miss.
    function nudge() external override {
        if (gasleft() < MasonryRangeLib.NUDGE_MIN_GAS) return;
        if (!_safeToMoveView() || !shouldRebalance()) return;
        try this.rebalance() {} catch {}
    }

    function shouldRebalance() public view returns (bool) {
        if (!seeded) return false;
        (uint160 sqrtPrice, int24 tick,,) = manager.getSlot0(poolId);
        (int24 targetLower, int24 targetUpper) = _bandTicks(sqrtPrice);
        if (targetLower == tickLower && targetUpper == tickUpper) return false;
        if (pegAnchor) {
            return MasonryRangeLib.needsRecenterToTarget(
                tick, tickLower, tickUpper, targetLower, targetUpper, lowerHalfWidthBps, upperHalfWidthBps, recenterBps
            );
        }
        return MasonryRangeLib.needsRecenter(tick, tickLower, tickUpper, halfWidthBps, recenterBps);
    }

    function previewRange() external view returns (int24 lower, int24 upper) {
        (uint160 sqrtPrice,,,) = manager.getSlot0(poolId);
        return _bandTicks(sqrtPrice);
    }

    function cooldownRemaining() public view returns (uint256) {
        if (lastRebalanceAt == 0) return 0;
        uint256 readyAt = lastRebalanceAt + cooldown;
        return block.timestamp >= readyAt ? 0 : readyAt - block.timestamp;
    }

    function status()
        external
        view
        returns (
            int24 lower,
            int24 upper,
            uint128 liq,
            int24 currentTick,
            bool inRange,
            bool needsMove,
            uint256 lastAt,
            uint256 cooldownLeft
        )
    {
        (, currentTick,,) = manager.getSlot0(poolId);
        lower = tickLower;
        upper = tickUpper;
        liq = liquidity;
        inRange = seeded && currentTick > lower && currentTick < upper;
        needsMove = shouldRebalance();
        lastAt = lastRebalanceAt;
        cooldownLeft = cooldownRemaining();
    }

    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotPoolManager();
        _execute(abi.decode(data, (Op)));
        return "";
    }

    function _run(
        Op op
    ) private {
        if (manager.isUnlocked()) {
            _execute(op);
        } else {
            manager.unlock(abi.encode(op));
        }
    }

    function _execute(
        Op op
    ) private {
        if (op == Op.Rebalance) {
            (uint256 before0, uint256 before1) = _inventory();
            (uint160 sqrtBefore,,,) = manager.getSlot0(poolId);
            uint256 beforeValue = MasonryRangeLib.valueInCurrency1(before0, before1, sqrtBefore);
            (uint256 principal0, uint256 principal1, uint256 fees0, uint256 fees1) = _removePosition();
            _setBandFromSpot();
            (int256 swap0, int256 swap1) = _rebalanceInventory();
            _addFromBalance();
            (uint256 after0, uint256 after1) = _inventory();
            uint256 afterValue = MasonryRangeLib.valueInCurrency1(after0, after1, sqrtBefore);
            if (MasonryRangeLib.exceedsLoss(beforeValue, afterValue, MasonryRangeLib.MAX_INVENTORY_LOSS_BPS)) {
                revert SlippageExceeded();
            }
            lastRebalanceAt = block.timestamp;
            lastRebalanceBlock = block.number;
            (, int24 tick,,) = manager.getSlot0(poolId);
            emit RangeRebalanced(tickLower, tickUpper, liquidity, tick, principal0, principal1, fees0, fees1, swap0, swap1);
            return;
        }
        if (!seeded) _setBandFromSpot();
        uint128 before = liquidity;
        uint256 paid0;
        uint256 paid1;
        (paid0, paid1) = _addFromBalance();
        if (before == 0 && liquidity != 0) emit RangeSeeded(tickLower, tickUpper, liquidity);
        emit RangeFunded(liquidity - before, paid0, paid1);
    }

    function _setBandFromSpot() private {
        _requireHonestSpot();
        (uint160 sqrtPrice,,,) = manager.getSlot0(poolId);
        (tickLower, tickUpper) = _bandTicks(sqrtPrice);
        seeded = true;
    }

    function _bandTicks(uint160 sqrtPrice) private view returns (int24 lower, int24 upper) {
        if (pegAnchor) {
            return MasonryRangeLib.pegAnchorTicks(sqrtPrice, sqrtPeg, lowerHalfWidthBps, upperHalfWidthBps, key.tickSpacing);
        }
        return MasonryRangeLib.bandTicks(sqrtPrice, halfWidthBps, key.tickSpacing);
    }

    function _requireHonestSpot() private view {
        if (manager.getLiquidity(poolId) < minPoolLiquidity) revert ThinPool();
        (uint256 twap,, bool valid) = twapOracle.latestValidatedTwap();
        if (!valid) revert UnsafeRebalance();
        (uint160 sqrtPrice,,,) = manager.getSlot0(poolId);
        uint256 spot = MasonryLevelPrice.fromSqrtPrice(sqrtPrice, assetIsCurrency0);
        if (MasonryRangeLib.deviationBps(spot, twap) > maxTwapDeviationBps) revert UnsafeRebalance();
    }


    function _rebalanceInventory() private returns (int256 swap0, int256 swap1) {
        IERC20 token0 = IERC20(Currency.unwrap(key.currency0));
        IERC20 token1 = IERC20(Currency.unwrap(key.currency1));
        uint256 bal0 = token0.balanceOf(address(this));
        uint256 bal1 = token1.balanceOf(address(this));
        if (bal0 == 0 && bal1 == 0) return (0, 0);
        (uint160 sqrtPrice,,,) = manager.getSlot0(poolId);
        uint160 sa = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sb = TickMath.getSqrtPriceAtTick(tickUpper);
        uint128 liquidity0 = LiquidityAmounts.getLiquidityForAmount0(sqrtPrice, sb, bal0);
        uint128 liquidity1 = LiquidityAmounts.getLiquidityForAmount1(sa, sqrtPrice, bal1);
        if (liquidity0 == liquidity1) return (0, 0);
        if (liquidity0 > liquidity1) {
            uint256 used0 = SqrtPriceMath.getAmount0Delta(sqrtPrice, sb, liquidity1, true);
            if (bal0 > used0) {
                return _swap(true, bal0 - used0, MasonryRangeLib.sqrtPriceLimit(sqrtPrice, maxTwapDeviationBps, true));
            }
        } else {
            uint256 used1 = SqrtPriceMath.getAmount1Delta(sa, sqrtPrice, liquidity0, true);
            if (bal1 > used1) {
                return _swap(false, bal1 - used1, MasonryRangeLib.sqrtPriceLimit(sqrtPrice, maxTwapDeviationBps, false));
            }
        }
    }

    function _swap(bool zeroForOne, uint256 amountIn, uint160 limit) private returns (int256 amount0, int256 amount1) {
        if (amountIn == 0) return (0, 0);
        BalanceDelta delta = manager.swap(
            key,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: limit}),
            ""
        );
        // _settleNegative also takes a positive credit so each currency is settled once.
        _settleNegative(key.currency0, delta.amount0());
        _settleNegative(key.currency1, delta.amount1());
        amount0 = delta.amount0();
        amount1 = delta.amount1();
    }

    function _inventory() private view returns (uint256 amount0, uint256 amount1) {
        amount0 = IERC20(Currency.unwrap(key.currency0)).balanceOf(address(this));
        amount1 = IERC20(Currency.unwrap(key.currency1)).balanceOf(address(this));
        if (liquidity == 0) return (amount0, amount1);
        (uint160 sqrtPrice,,,) = manager.getSlot0(poolId);
        uint160 sa = TickMath.getSqrtPriceAtTick(tickLower);
        uint160 sb = TickMath.getSqrtPriceAtTick(tickUpper);
        if (sqrtPrice <= sa) {
            amount0 += SqrtPriceMath.getAmount0Delta(sa, sb, liquidity, false);
        } else if (sqrtPrice >= sb) {
            amount1 += SqrtPriceMath.getAmount1Delta(sa, sb, liquidity, false);
        } else {
            amount0 += SqrtPriceMath.getAmount0Delta(sqrtPrice, sb, liquidity, false);
            amount1 += SqrtPriceMath.getAmount1Delta(sa, sqrtPrice, liquidity, false);
        }
    }

    function _removePosition()
        private
        returns (uint256 principal0, uint256 principal1, uint256 fees0, uint256 fees1)
    {
        if (liquidity == 0) return (0, 0, 0, 0);
        (BalanceDelta delta, BalanceDelta feesAccrued) = manager.modifyLiquidity(
            key, ModifyLiquidityParams(tickLower, tickUpper, -int256(uint256(liquidity)), bytes32(0)), ""
        );
        liquidity = 0;
        _takePositive(key.currency0, delta.amount0());
        _takePositive(key.currency1, delta.amount1());
        fees0 = _positive(feesAccrued.amount0());
        fees1 = _positive(feesAccrued.amount1());
        uint256 total0 = _positive(delta.amount0());
        uint256 total1 = _positive(delta.amount1());
        principal0 = total0 > fees0 ? total0 - fees0 : 0;
        principal1 = total1 > fees1 ? total1 - fees1 : 0;
    }

    function _positive(int128 amount) private pure returns (uint256) {
        return amount > 0 ? uint256(uint128(amount)) : 0;
    }

    function _addFromBalance() private returns (uint256 paid0, uint256 paid1) {
        IERC20 token0 = IERC20(Currency.unwrap(key.currency0));
        IERC20 token1 = IERC20(Currency.unwrap(key.currency1));
        uint256 bal0 = token0.balanceOf(address(this));
        uint256 bal1 = token1.balanceOf(address(this));
        if (bal0 == 0 && bal1 == 0) return (0, 0);
        (uint160 sqrtPrice,,,) = manager.getSlot0(poolId);
        uint128 add = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPrice, TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), bal0, bal1
        );
        if (add == 0) return (0, 0);
        (BalanceDelta delta,) = manager.modifyLiquidity(
            key, ModifyLiquidityParams(tickLower, tickUpper, int256(uint256(add)), bytes32(0)), ""
        );
        paid0 = _settleNegative(key.currency0, delta.amount0());
        paid1 = _settleNegative(key.currency1, delta.amount1());
        liquidity += add;
    }

    function _takePositive(
        Currency currency,
        int128 amount
    ) private {
        if (amount > 0) manager.take(currency, address(this), uint256(uint128(amount)));
    }

    function _settleNegative(
        Currency currency,
        int128 amount
    ) private returns (uint256 paid) {
        if (amount >= 0) {
            if (amount > 0) manager.take(currency, address(this), uint256(uint128(amount)));
            return 0;
        }
        paid = uint256(uint128(-amount));
        manager.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransfer(address(manager), paid);
        manager.settle();
    }

    function _pull(
        address from,
        uint256 maxAsset,
        uint256 maxQuote
    ) private {
        (uint256 amount0, uint256 amount1) = assetIsCurrency0 ? (maxAsset, maxQuote) : (maxQuote, maxAsset);
        _pullRaw(from, amount0, amount1);
    }

    function _pullRaw(
        address from,
        uint256 amount0,
        uint256 amount1
    ) private {
        if (amount0 != 0) IERC20(Currency.unwrap(key.currency0)).safeTransferFrom(from, address(this), amount0);
        if (amount1 != 0) IERC20(Currency.unwrap(key.currency1)).safeTransferFrom(from, address(this), amount1);
    }

    function _requireSafeToMove() private view {
        if (lastRebalanceBlock == block.number) revert SameBlockRebalance();
        if (lastRebalanceAt != 0 && block.timestamp < lastRebalanceAt + cooldown) revert CooldownActive();
        _requireHonestSpot();
    }

    function _safeToMoveView() private view returns (bool) {
        if (lastRebalanceBlock == block.number) return false;
        if (lastRebalanceAt != 0 && block.timestamp < lastRebalanceAt + cooldown) return false;
        if (manager.getLiquidity(poolId) < minPoolLiquidity) return false;
        (uint256 twap,, bool valid) = twapOracle.latestValidatedTwap();
        if (!valid) return false;
        (uint160 sqrtPrice,,,) = manager.getSlot0(poolId);
        uint256 spot = MasonryLevelPrice.fromSqrtPrice(sqrtPrice, assetIsCurrency0);
        return MasonryRangeLib.deviationBps(spot, twap) <= maxTwapDeviationBps;
    }
}
