// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {MasonryTaxHook} from "./MasonryTaxHook.sol";
import {MasonryLevelHook} from "./MasonryLevelHook.sol";
import {MasonryGenesisSchedule} from "../masonry/MasonryGenesisSchedule.sol";
import {MasonryCriticalDefense} from "../masonry/MasonryCriticalDefense.sol";
import {MasonryLevelPrice} from "../masonry/MasonryLevelPrice.sol";
import {IMasonryPolSink} from "../masonry/IMasonryPolSink.sol";
import {MasonryLevelOracle} from "../masonry/MasonryLevelOracle.sol";
import {IMasonryBurnableLevel} from "../masonry/MasonryGenesisLPBurnFee.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";

/// @notice Flat X Share sell tax. Proceeds accumulate and are spent on an X Tomb
/// buy-and-burn via a separate permissionless call (not inside the user swap).
contract MasonrySquareHook is MasonryTaxHook, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using TransientStateLibrary for IPoolManager;

    uint16 public constant BOOTSTRAP_TAX_BPS = 600;
    uint256 private constant ROUTE_GAS = 650_000;
    uint256 private constant BPS = 10_000;
    uint16 public immutable shareSellTaxBps;
    uint256 public pendingBuybackSquare;

    struct RoutingConfig {
        PoolKey levelPool;
        address treasury;
        address polBinder;
        uint256 squareReferencePrice;
        uint128 maxSquarePerRoute;
        uint16 maxDeviationBps;
        MasonryCriticalDefense defense;
        uint16 shareSellTaxBps;
    }

    MasonryGenesisSchedule public immutable schedule;
    MasonryLevelHook public immutable levelHook;
    MasonryCriticalDefense public immutable defense;
    address public immutable treasury;
    uint256 public immutable squareReferencePrice;
    uint128 public immutable maxSquarePerRoute;
    uint16 public immutable maxDeviationBps;

    address public immutable polBinder;
    IMasonryPolSink public polVault;
    PoolKey private levelPool;
    uint256 public polSquare;
    uint256 public polUsdc;
    uint256 public usdcReserveSquare;
    uint256 public retainedSquare;
    uint256 public deferredSquareClaims;
    uint256 public criticalSquare;
    uint256 public usdcRouted;
    uint256 public levelBurned;

    error UnsafeRoute();

    event SellTax(uint256 squareAmount, uint16 rateBps);
    event SquareAllocated(uint256 pol, uint256 usdcReserve, uint256 retained, uint256 critical);
    event RouteDeferred(bool indexed critical);
    event PolDeferred();
    event ClaimMaterializationDeferred();
    event PolFunded(uint256 shares, uint256 square, uint256 usdc);
    event RouteSettled(bool indexed critical, uint256 squareIn, uint256 amountOut);

    constructor(
        IPoolManager manager,
        OracleConfig memory oracleConfig,
        address square,
        address usdc,
        uint24 lpFee,
        int24 spacing,
        RoutingConfig memory config
    ) MasonryTaxHook(manager, oracleConfig, square, usdc, lpFee, spacing) {
        MasonryLevelHook hook = MasonryLevelHook(address(config.levelPool.hooks));
        if (
            address(hook).code.length == 0 || hook.poolManager() != manager || hook.level() == square
                || PoolId.unwrap(config.levelPool.toId()) != PoolId.unwrap(hook.officialPool())
                || Currency.unwrap(hook.levelIsCurrency0() ? config.levelPool.currency1 : config.levelPool.currency0)
                    != usdc || config.treasury == address(0) || config.polBinder == address(0)
                || config.squareReferencePrice == 0 || config.squareReferencePrice > 1e36
                || config.maxSquarePerRoute == 0 || config.maxSquarePerRoute > uint256(uint128(type(int128).max))
                || config.maxDeviationBps == 0 || config.maxDeviationBps > 500
                || config.shareSellTaxBps == 0 || config.shareSellTaxBps > MAX_TAX_BPS
        ) revert InvalidConfiguration();
        polBinder = config.polBinder;
        levelPool = config.levelPool;
        levelHook = hook;
        schedule = hook.schedule();
        if (address(config.defense).code.length == 0 || address(config.defense.oracle()) != address(hook.oracle())) {
            revert InvalidConfiguration();
        }
        defense = config.defense;
        treasury = config.treasury;
        squareReferencePrice = config.squareReferencePrice;
        maxSquarePerRoute = config.maxSquarePerRoute;
        maxDeviationBps = config.maxDeviationBps;
        shareSellTaxBps = config.shareSellTaxBps;
    }

    function _sellTaxBps() internal view override returns (uint16) {
        return shareSellTaxBps;
    }

    function bindPolVault(
        IMasonryPolSink vault
    ) external {
        if (
            msg.sender != polBinder || address(polVault) != address(0) || address(vault).code.length == 0
                || PoolId.unwrap(vault.poolKey().toId()) != PoolId.unwrap(officialPool)
                || vault.manager() != poolManager
        ) {
            revert InvalidConfiguration();
        }
        polVault = vault;
    }

    function _collectTax(
        uint256 amount,
        uint16 rate
    ) internal override {
        Currency square = Currency.wrap(asset);
        if (poolManager.getSyncedCurrency() == square) {
            // Mint v4 claims without changing the caller's ERC20 snapshot.
            // Claims are materialized before a later buy-and-burn.
            poolManager.mint(address(this), square.toId(), amount);
            deferredSquareClaims += amount;
        } else {
            poolManager.take(square, address(this), amount);
        }
        pendingBuybackSquare += amount;
        emit SellTax(amount, rate);
    }

    /// @notice Permissionless X Share → USDG → X Tomb buy-and-burn.
    /// Not invoked from `afterSwap`, so it cannot sandwich or reenter the user's swap.
    /// Slippage is bounded by TWAP (`maxDeviationBps`) inside `_swapGuarded`.
    function buyAndBurn() external {
        poolManager.unlock("");
    }

    function unlockCallback(bytes calldata) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlySelf();
        _executeBuyback();
        return "";
    }

    function _executeBuyback() private {
        if (deferredSquareClaims != 0) {
            uint256 materialize = deferredSquareClaims < maxSquarePerRoute ? deferredSquareClaims : maxSquarePerRoute;
            deferredSquareClaims -= materialize;
            Currency square = Currency.wrap(asset);
            poolManager.burn(address(this), square.toId(), materialize);
            poolManager.take(square, address(this), materialize);
        }
        uint256 amount = pendingBuybackSquare < maxSquarePerRoute ? pendingBuybackSquare : maxSquarePerRoute;
        if (amount == 0) revert UnsafeRoute();
        pendingBuybackSquare -= amount;
        PoolKey memory squarePool = officialPoolKey();
        uint256 usdcAmount = _swapGuarded(squarePool, oracle, assetIsCurrency0, amount, true);
        _recordPool(true);
        uint256 received = _swapGuarded(levelPool, levelHook.oracle(), !levelHook.levelIsCurrency0(), usdcAmount, false);
        IMasonryBurnableLevel(levelHook.level()).burn(received);
        levelBurned += received;
        emit RouteSettled(true, amount, received);
    }

    function _afterSell(
        PoolKey calldata squarePool
    ) internal override {
        // Preserve a composable caller's in-progress ERC20 settlement snapshot.
        if (!poolManager.getSyncedCurrency().isAddressZero()) return;
        if (deferredSquareClaims != 0 && gasleft() > 250_000) {
            try this.materializeClaims{gas: 100_000}() {}
            catch {
                emit ClaimMaterializationDeferred();
            }
        }
        if (usdcReserveSquare != 0 && gasleft() > ROUTE_GAS + 150_000) {
            try this.route{gas: ROUTE_GAS}(squarePool, false) {}
            catch {
                emit RouteDeferred(false);
            }
        }
        if (criticalSquare != 0 && gasleft() > ROUTE_GAS + 150_000) {
            try this.route{gas: ROUTE_GAS}(squarePool, true) {}
            catch {
                emit RouteDeferred(true);
            }
        }
        if (address(polVault) != address(0) && (polSquare != 0 || polUsdc != 0) && gasleft() > ROUTE_GAS + 150_000) {
            try this.routePol{gas: ROUTE_GAS}(squarePool) {}
            catch {
                emit PolDeferred();
            }
        }
    }

    function materializeClaims() external {
        if (msg.sender != address(this)) revert OnlySelf();
        uint256 amount = deferredSquareClaims < maxSquarePerRoute ? deferredSquareClaims : maxSquarePerRoute;
        deferredSquareClaims -= amount;
        Currency square = Currency.wrap(asset);
        poolManager.burn(address(this), square.toId(), amount);
        poolManager.take(square, address(this), amount);
    }

    function routePol(
        PoolKey calldata squarePool
    ) external {
        if (msg.sender != address(this)) revert OnlySelf();
        uint256 squareBudget = polSquare < maxSquarePerRoute ? polSquare : maxSquarePerRoute;
        (, int24 tick,,) = poolManager.getSlot0(officialPool);
        bool onlySquare = assetIsCurrency0 ? tick < polVault.tickLower() : tick >= polVault.tickUpper();
        bool onlyUsdc = assetIsCurrency0 ? tick >= polVault.tickUpper() : tick < polVault.tickLower();
        uint256 sellAmount = onlySquare ? 0 : onlyUsdc ? squareBudget : squareBudget / 2;

        uint256 twap = oracle.validatedPrice(officialPool);
        _checkDeviation(_price(officialPool, assetIsCurrency0), twap);
        if (sellAmount != 0) {
            polUsdc += _swapGuarded(squarePool, oracle, assetIsCurrency0, sellAmount, true);
            polSquare -= sellAmount;
            squareBudget -= sellAmount;
            _recordPool(true);
        }

        IERC20 square = IERC20(asset);
        IERC20 usdc = IERC20(Currency.unwrap(assetIsCurrency0 ? squarePool.currency1 : squarePool.currency0));
        square.forceApprove(address(polVault), squareBudget);
        usdc.forceApprove(address(polVault), polUsdc);
        (uint256 shares, uint256 squareUsed, uint256 usdcUsed) =
            polVault.depositFromHook(squareBudget, polUsdc, treasury);
        square.forceApprove(address(polVault), 0);
        usdc.forceApprove(address(polVault), 0);
        polSquare -= squareUsed;
        polUsdc -= usdcUsed;
        emit PolFunded(shares, squareUsed, usdcUsed);
    }

    /// @dev Self-only and reached from the original swap callback. A failed
    /// route rolls back its own swaps, transfers, and earmark changes.
    function route(
        PoolKey calldata squarePool,
        bool critical
    ) external {
        if (msg.sender != address(this)) revert OnlySelf();
        uint256 available = critical ? criticalSquare : usdcReserveSquare;
        uint256 amount = available < maxSquarePerRoute ? available : maxSquarePerRoute;
        if (critical) criticalSquare -= amount;
        else usdcReserveSquare -= amount;

        uint256 usdcAmount = _swapGuarded(squarePool, oracle, assetIsCurrency0, amount, true);
        _recordPool(true); // The PoolManager skips hooks for the hook's own SQUARE swap.
        uint256 received = usdcAmount;
        if (critical) {
            received = _swapGuarded(levelPool, levelHook.oracle(), !levelHook.levelIsCurrency0(), usdcAmount, false);
            IMasonryBurnableLevel(levelHook.level()).burn(received);
            levelBurned += received;
        } else {
            Currency usdc = assetIsCurrency0 ? squarePool.currency1 : squarePool.currency0;
            IERC20(Currency.unwrap(usdc)).safeTransfer(treasury, received);
            usdcRouted += received;
        }
        emit RouteSettled(critical, amount, received);
    }

    function _swapGuarded(
        PoolKey memory key,
        MasonryLevelOracle feed,
        bool zeroForOne,
        uint256 amount,
        bool sell
    ) private returns (uint256 output) {
        if (amount == 0 || amount > uint256(uint128(type(int128).max))) revert UnsafeRoute();
        PoolId id = key.toId();
        uint256 twap = feed.validatedPrice(id);
        bool token0 = sell == zeroForOne;
        uint256 spot = _price(id, token0);
        _checkDeviation(spot, twap);
        if (poolManager.getLiquidity(id) < feed.minLiquidity()) revert UnsafeRoute();

        BalanceDelta delta = poolManager.swap(
            key,
            SwapParams(
                zeroForOne, -int256(amount), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            ""
        );
        int128 paid = zeroForOne ? delta.amount0() : delta.amount1();
        int128 received = zeroForOne ? delta.amount1() : delta.amount0();
        if (paid != -int256(amount) || received <= 0 || poolManager.getLiquidity(id) < feed.minLiquidity()) {
            revert UnsafeRoute();
        }
        output = uint256(uint128(received));
        _checkDeviation(_price(id, token0), spot);
        uint256 expected = sell ? FullMath.mulDiv(amount, twap, 1e30) : FullMath.mulDiv(amount, 1e30, twap);
        if (output < FullMath.mulDivRoundingUp(expected, BPS - maxDeviationBps, BPS)) revert UnsafeRoute();

        Currency input = zeroForOne ? key.currency0 : key.currency1;
        Currency out = zeroForOne ? key.currency1 : key.currency0;
        poolManager.sync(input);
        IERC20(Currency.unwrap(input)).safeTransfer(address(poolManager), amount);
        if (poolManager.settle() != amount) revert UnsafeRoute();
        poolManager.take(out, address(this), output);
    }

    function _price(
        PoolId pool,
        bool token0
    ) private view returns (uint256) {
        (uint160 sqrtPrice,,,) = poolManager.getSlot0(pool);
        return MasonryLevelPrice.fromSqrtPrice(sqrtPrice, token0);
    }

    function _checkDeviation(
        uint256 price,
        uint256 referencePrice
    ) private view {
        uint256 deviation = price > referencePrice ? price - referencePrice : referencePrice - price;
        if (deviation > FullMath.mulDiv(referencePrice, maxDeviationBps, BPS)) revert UnsafeRoute();
    }

    function _bootstrapFloor() internal view override returns (uint16) {
        return schedule.active() ? BOOTSTRAP_TAX_BPS : 0;
    }

    function _referencePrice() internal view override returns (uint256) {
        return squareReferencePrice;
    }
}
