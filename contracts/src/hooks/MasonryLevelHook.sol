// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
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
import {MasonryGenesisSchedule} from "../masonry/MasonryGenesisSchedule.sol";
import {MasonryLevelOracle} from "../masonry/MasonryLevelOracle.sol";
import {MasonryLevelPrice} from "../masonry/MasonryLevelPrice.sol";
import {MasonryRules} from "../masonry/MasonryRules.sol";
import {IMasonryBurnableLevel} from "../masonry/MasonryGenesisLPBurnFee.sol";

/// @notice LEVEL sell tax on the canonical, static-fee LEVEL/USDC v4 pool.
contract MasonryLevelHook is BaseV4Hook {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint16 public constant GENESIS_MIN_TAX_BPS = 300;
    uint16 public constant MAX_TAX_BPS = MasonryRules.HARD_MAX_FIRE_TAX_BPS;
    uint16 private constant BASE_TAX = MasonryRules.DEFAULT_BASE_FIRE_TAX_BPS;
    uint256 private constant BPS = 10_000;

    MasonryGenesisSchedule public immutable schedule;
    MasonryLevelOracle public immutable oracle;
    uint160 private recordedSqrtPrice;
    address public immutable level;
    address public immutable taxRecipient;
    PoolId public immutable officialPool;
    bool public immutable levelIsCurrency0;

    uint16 public raisedBps = BASE_TAX;
    uint256 public raisedAt;
    uint256 public genesisLevelBurned;

    error InvalidConfiguration();
    error UnknownPool();
    error OnlySelf();
    error PartialSell();
    error UnrepresentableTax();
    error InvalidOraclePrice();
    error SimulationFailed();
    error Simulated(uint256 input, uint160 sqrtPriceX96);

    event SellTax(uint256 levelAmount, uint16 rateBps, bool burned);

    constructor(
        IPoolManager manager,
        MasonryGenesisSchedule schedule_,
        uint128 minOracleLiquidity,
        address level_,
        address usdc,
        address recipient,
        uint24 lpFee,
        int24 tickSpacing
    ) BaseV4Hook(manager) {
        if (
            address(schedule_).code.length == 0 || level_ == usdc || recipient == address(0)
                || lpFee >= LPFeeLibrary.MAX_LP_FEE || IERC20Metadata(level_).decimals() != 18
                || IERC20Metadata(usdc).decimals() != 6
        ) revert InvalidConfiguration();
        schedule = schedule_;
        level = level_;
        taxRecipient = recipient;
        levelIsCurrency0 = level_ < usdc;
        officialPool = PoolKey({
            currency0: Currency.wrap(levelIsCurrency0 ? level_ : usdc),
            currency1: Currency.wrap(levelIsCurrency0 ? usdc : level_),
            fee: lpFee,
            tickSpacing: tickSpacing,
            hooks: IHooks(address(this))
        }).toId();
        oracle = new MasonryLevelOracle(officialPool, levelIsCurrency0, minOracleLiquidity);
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
        address,
        PoolKey calldata key,
        uint160
    ) external view override onlyPoolManager returns (bytes4) {
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
        address,
        PoolKey calldata,
        SwapParams calldata,
        BalanceDelta,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, int128) {
        _recordPool(true);
        return (IHooks.afterSwap.selector, 0);
    }

    /// @notice Saves a history checkpoint without refreshing the last-price-change time.
    function checkpoint() external {
        _recordPool(false);
    }

    function _recordPool(
        bool swap
    ) private {
        (uint160 sqrtPrice, int24 tick,,) = poolManager.getSlot0(officialPool);
        if (sqrtPrice == 0) revert UnknownPool();
        bool priceChanged = swap && sqrtPrice != recordedSqrtPrice;
        recordedSqrtPrice = sqrtPrice;
        oracle.record(tick, poolManager.getLiquidity(officialPool), priceChanged);
    }

    function beforeSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata
    ) external override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(officialPool)) revert UnknownPool();
        if (params.zeroForOne != levelIsCurrency0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        bool genesis = schedule.active();
        (uint256 fee, uint16 rate) = _quote(key, params, genesis);
        if (fee == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        if (fee > uint256(uint128(type(int128).max))) revert InvalidConfiguration();

        poolManager.take(Currency.wrap(level), address(this), fee);
        if (genesis) {
            IMasonryBurnableLevel(level).burn(fee);
            genesisLevelBurned += fee;
        } else {
            IERC20(level).safeTransfer(taxRecipient, fee);
        }
        emit SellTax(fee, rate, genesis);

        int128 delta = int128(int256(fee));
        return (
            IHooks.beforeSwap.selector,
            params.amountSpecified < 0 ? toBeforeSwapDelta(delta, 0) : toBeforeSwapDelta(0, delta),
            0
        );
    }

    function _quote(
        PoolKey calldata key,
        SwapParams calldata params,
        bool genesis
    ) private returns (uint256 fee, uint16 rate) {
        bool exactInput = params.amountSpecified < 0;
        uint16 recovery = MasonryRules.recoveryFloorBps(raisedBps, BASE_TAX, raisedAt, block.timestamp);
        uint256 twap = _validatedTwap();
        if (twap == 0) revert InvalidOraclePrice();
        uint16 ordinaryFloor = MasonryRules.effectiveSellTaxBps(_target(twap), recovery, BASE_TAX);
        uint16 minimum = genesis && ordinaryFloor < GENESIS_MIN_TAX_BPS ? GENESIS_MIN_TAX_BPS : ordinaryFloor;

        // The largest possible net LEVEL input gives a conservative post-sale price.
        // Any higher tax can only reduce the executed net input and price impact.
        SwapParams memory preview = params;
        if (exactInput) {
            uint256 gross = uint256(-params.amountSpecified);
            preview.amountSpecified += int256(FullMath.mulDiv(gross, minimum, BPS));
        }
        (uint256 input, uint160 sqrtPrice) = _project(key, preview);
        uint16 target = MasonryRules.effectiveSellTaxBps(
            _target(twap), _target(MasonryLevelPrice.fromSqrtPrice(sqrtPrice, levelIsCurrency0)), BASE_TAX
        );
        if (target > raisedBps || (block.timestamp - raisedAt >= MasonryRules.FIRE_TAX_RECOVERY && target > BASE_TAX)) {
            raisedBps = target;
            raisedAt = block.timestamp;
        }
        rate = target > minimum ? target : minimum;

        // Exact-output specifies USDC, so gross up the simulated net LEVEL
        // input to make the rate a share of the total LEVEL paid.
        uint256 taxBase = exactInput ? uint256(-params.amountSpecified) : input;
        fee = FullMath.mulDiv(taxBase, rate, exactInput ? BPS : BPS - rate);
        if (genesis) {
            // Reject dust if no whole LEVEL unit satisfies both bounds.
            uint256 floor =
                FullMath.mulDivRoundingUp(taxBase, GENESIS_MIN_TAX_BPS, exactInput ? BPS : BPS - GENESIS_MIN_TAX_BPS);
            uint256 ceiling = FullMath.mulDiv(taxBase, MAX_TAX_BPS, exactInput ? BPS : BPS - MAX_TAX_BPS);
            if (floor > ceiling) revert UnrepresentableTax();
            if (fee < floor) fee = floor;
        }
    }

    function simulate(
        PoolKey calldata key,
        SwapParams calldata params
    ) external {
        if (msg.sender != address(this)) revert OnlySelf();
        // v4 skips callbacks for a swap initiated by its own hook. Reverting
        // rolls back the simulated swap, including fee and balance deltas.
        BalanceDelta result = poolManager.swap(key, params, "");
        int128 input = levelIsCurrency0 ? result.amount0() : result.amount1();
        int128 output = levelIsCurrency0 ? result.amount1() : result.amount0();
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
    ) private pure returns (uint16) {
        return MasonryRules.targetSellTaxBps(price, 1e18, BASE_TAX, MAX_TAX_BPS, 1500);
    }
}
