// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {BaseV4Hook} from "./base/BaseV4Hook.sol";
import {MasonryLevelOracle} from "../masonry/MasonryLevelOracle.sol";
import {MasonryLevelPrice} from "../masonry/MasonryLevelPrice.sol";
import {MasonryRules} from "../masonry/MasonryRules.sol";
import {IMasonryRangeNudge} from "../masonry/IMasonryPolSink.sol";
import {MasonryRangeManager} from "../masonry/MasonryRangeManager.sol";
import {MasonryRangeLib} from "../masonry/MasonryRangeLib.sol";
import {IMasonryFireTax} from "../masonry/IMasonryFireTax.sol";

/// @notice Official-pool hook: oracle/range binding, optional share sell tax, and the
/// live Fire Tax withdraw-fee view. X Tomb sells are not taxed.
abstract contract MasonryTaxHook is BaseV4Hook, IMasonryFireTax {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint16 public constant MAX_TAX_BPS = MasonryRules.HARD_MAX_FIRE_TAX_BPS;
    uint16 private constant BASE_TAX = MasonryRules.DEFAULT_BASE_FIRE_TAX_BPS;
    uint256 private constant BPS = 10_000;

    struct OracleConfig {
        MasonryLevelOracle oracle;
        address initializer;
    }

    MasonryLevelOracle public immutable oracle;
    address private immutable _initializer;
    uint160 private recordedSqrtPrice;
    address public rangeManager;
    address public immutable asset;
    address public immutable quoteToken;
    uint24 public immutable poolFee;
    int24 public immutable poolSpacing;
    PoolId public immutable officialPool;
    bool public immutable assetIsCurrency0;

    uint16 public raisedBps = BASE_TAX;
    uint256 public raisedAt;

    error InvalidConfiguration();
    error UnknownPool();
    error UnauthorizedInitializer();
    error OnlySelf();
    error PartialSell();
    error UnrepresentableTax();
    error InvalidOraclePrice();
    error SimulationFailed();
    error Simulated(uint256 input, uint160 sqrtPriceX96);

    constructor(
        IPoolManager manager,
        OracleConfig memory config,
        address asset_,
        address usdc,
        uint24 lpFee,
        int24 tickSpacing
    ) BaseV4Hook(manager) {
        if (
            asset_ == usdc || lpFee >= LPFeeLibrary.MAX_LP_FEE || IERC20Metadata(asset_).decimals() != 18
                || IERC20Metadata(usdc).decimals() != 6
        ) revert InvalidConfiguration();
        asset = asset_;
        quoteToken = usdc;
        poolFee = lpFee;
        poolSpacing = tickSpacing;
        assetIsCurrency0 = asset_ < usdc;
        officialPool = PoolKey({
            currency0: Currency.wrap(assetIsCurrency0 ? asset_ : usdc),
            currency1: Currency.wrap(assetIsCurrency0 ? usdc : asset_),
            fee: lpFee,
            tickSpacing: tickSpacing,
            hooks: IHooks(address(this))
        }).toId();
        if (
            config.initializer == address(0) || address(config.oracle).code.length == 0
                || config.oracle.hook() != address(this)
                || PoolId.unwrap(config.oracle.officialPool()) != PoolId.unwrap(officialPool)
                || config.oracle.levelIsCurrency0() != assetIsCurrency0
        ) revert InvalidConfiguration();
        oracle = config.oracle;
        _initializer = config.initializer;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions.beforeInitialize = true;
        permissions.afterInitialize = true;
        permissions.afterSwap = true;
        permissions.afterAddLiquidity = true;
        permissions.afterRemoveLiquidity = true;
        permissions.beforeSwap = true;
        permissions.beforeSwapReturnDelta = true;
    }

    function beforeInitialize(
        address sender,
        PoolKey calldata key,
        uint160
    ) external view override onlyPoolManager returns (bytes4) {
        if (sender != _initializer) revert UnauthorizedInitializer();
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(officialPool)) revert UnknownPool();
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(
        address,
        PoolKey calldata,
        uint160 sqrtPrice,
        int24 tick
    ) external override onlyPoolManager returns (bytes4) {
        recordedSqrtPrice = sqrtPrice;
        oracle.record(tick, 0, false);
        return IHooks.afterInitialize.selector;
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, BalanceDelta) {
        _recordPool(false);
        return (IHooks.afterAddLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, BalanceDelta) {
        _recordPool(false);
        return (IHooks.afterRemoveLiquidity.selector, BalanceDeltaLibrary.ZERO_DELTA);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, int128) {
        _recordPool(true);
        if (sender == rangeManager) return (IHooks.afterSwap.selector, 0);
        if (params.zeroForOne == assetIsCurrency0) _afterSell(key);
        _nudgeRange();
        return (IHooks.afterSwap.selector, 0);
    }

    /// @notice One-shot bind of the protocol-managed range manager for this official pool.
    /// @dev Only the launch initializer may bind; the launch script also checks `rm` against the
    ///      planned CREATE3 address. A permissionless bind would let anyone claim the Fire Tax exemption.
    function bindRangeManager(
        MasonryRangeManager rm
    ) external {
        if (msg.sender != _initializer) revert UnauthorizedInitializer();
        if (
            rangeManager != address(0) || address(rm).code.length == 0 || rm.hook() != address(this)
                || PoolId.unwrap(rm.poolId()) != PoolId.unwrap(officialPool) || rm.manager() != poolManager
        ) revert InvalidConfiguration();
        rangeManager = address(rm);
    }

    function _nudgeRange() internal {
        address rm = rangeManager;
        if (rm == address(0) || gasleft() < MasonryRangeLib.NUDGE_STIPEND + MasonryRangeLib.NUDGE_HOOK_BUFFER) return;
        try IMasonryRangeNudge(rm).nudge{gas: MasonryRangeLib.NUDGE_STIPEND}() {} catch {}
    }

    /// @notice Saves a history checkpoint without refreshing the last-price-change time.
    function checkpoint() external {
        _recordPool(false);
    }

    function _recordPool(
        bool swap
    ) internal {
        (uint160 sqrtPrice, int24 tick,,) = poolManager.getSlot0(officialPool);
        if (sqrtPrice == 0) revert UnknownPool();
        bool priceChanged = swap && sqrtPrice != recordedSqrtPrice;
        recordedSqrtPrice = sqrtPrice;
        oracle.record(tick, poolManager.getLiquidity(officialPool), priceChanged);
        _observeFireTax();
    }

    function officialPoolKey() public view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(assetIsCurrency0 ? asset : quoteToken),
            currency1: Currency.wrap(assetIsCurrency0 ? quoteToken : asset),
            fee: poolFee,
            tickSpacing: poolSpacing,
            hooks: IHooks(address(this))
        });
    }

    function beforeSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(officialPool)) revert UnknownPool();
        if (sender == rangeManager) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        if (params.zeroForOne != assetIsCurrency0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        // X Tomb (and any hook that leaves _sellTaxBps at 0) charges no swap tax.
        // X Share overrides this with a flat, config-driven sell tax.
        uint16 rate = _sellTaxBps();
        if (rate == 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }
        uint256 fee = _flatTaxFee(key, params, rate);
        if (fee == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        if (fee > uint256(uint128(type(int128).max))) revert InvalidConfiguration();

        _collectTax(fee, rate);

        int128 delta = int128(int256(fee));
        return (
            IHooks.beforeSwap.selector,
            params.amountSpecified < 0 ? toBeforeSwapDelta(delta, 0) : toBeforeSwapDelta(0, delta),
            0
        );
    }

    function _flatTaxFee(
        PoolKey calldata key,
        SwapParams calldata params,
        uint16 rate
    ) private returns (uint256 fee) {
        bool exactInput = params.amountSpecified < 0;
        if (exactInput) {
            return FullMath.mulDiv(uint256(-params.amountSpecified), rate, BPS);
        }
        (uint256 input,) = _project(key, params);
        return FullMath.mulDiv(input, rate, BPS - rate);
    }

    /// @notice 0 = no swap sell tax (X Tomb). Share hook returns the flat configured rate.
    function _sellTaxBps() internal view virtual returns (uint16) {
        return 0;
    }

    function peekValidatedTwap() public view returns (uint256) {
        return _validatedTwap();
    }

    function _observeFireTax() internal {
        uint256 twap;
        try this.peekValidatedTwap() returns (uint256 price) {
            twap = price;
        } catch {
            return;
        }
        if (twap == 0) return;
        uint16 target = _target(twap);
        if (target > raisedBps || (block.timestamp - raisedAt >= MasonryRules.FIRE_TAX_RECOVERY && target > BASE_TAX)) {
            raisedBps = target;
            raisedAt = block.timestamp;
        }
    }

    /// @inheritdoc IMasonryFireTax
    function currentWithdrawFeeBps() public view returns (uint16) {
        uint256 twap = _validatedTwap();
        if (twap == 0) revert InvalidOraclePrice();
        return MasonryRules.withdrawFeeBps(
            twap,
            _referencePrice(),
            BASE_TAX,
            MAX_TAX_BPS,
            MasonryRules.DEFAULT_FULL_TAX_DROP_BPS,
            raisedBps,
            raisedAt,
            block.timestamp
        );
    }

    /// @inheritdoc IMasonryFireTax
    function syncWithdrawFeeBps() external returns (uint16) {
        _observeFireTax();
        return currentWithdrawFeeBps();
    }

    function simulate(
        PoolKey calldata key,
        SwapParams calldata params
    ) external {
        if (msg.sender != address(this)) revert OnlySelf();
        // v4 skips callbacks for a swap initiated by its own hook. Reverting
        // rolls back the simulated swap, including fee and balance deltas.
        BalanceDelta result = poolManager.swap(key, params, "");
        int128 input = assetIsCurrency0 ? result.amount0() : result.amount1();
        int128 output = assetIsCurrency0 ? result.amount1() : result.amount0();
        if (input >= 0 || output <= 0) revert PartialSell();
        if (params.amountSpecified < 0 ? input != params.amountSpecified : output != params.amountSpecified) {
            revert PartialSell();
        }
        (uint160 sqrtPrice,,,) = poolManager.getSlot0(officialPool);
        revert Simulated(uint256(-int256(input)), sqrtPrice);
    }

    function _project(
        PoolKey calldata key,
        SwapParams memory params
    ) private returns (uint256 input, uint160 sqrtPrice) {
        (bool ok, bytes memory result) = address(this).call(abi.encodeCall(this.simulate, (key, params)));
        if (ok || result.length != 68 || bytes4(result) != Simulated.selector) revert SimulationFailed();
        assembly ("memory-safe") {
            input := mload(add(result, 36))
            sqrtPrice := mload(add(result, 68))
        }
    }

    function _validatedTwap() internal view virtual returns (uint256) {
        return oracle.validatedPrice(officialPool);
    }

    function _target(
        uint256 price
    ) private view returns (uint16) {
        return MasonryRules.targetSellTaxBps(
            price, _referencePrice(), BASE_TAX, MAX_TAX_BPS, MasonryRules.DEFAULT_FULL_TAX_DROP_BPS
        );
    }
    function _collectTax(
        uint256 amount,
        uint16 rate
    ) internal virtual;
    function _bootstrapFloor() internal view virtual returns (uint16);
    function _referencePrice() internal view virtual returns (uint256);
    function _afterSell(
        PoolKey calldata
    ) internal virtual {}
}
