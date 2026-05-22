// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";

import {BaseV4Hook} from "./base/BaseV4Hook.sol";
import {IPriceSource} from "../interfaces/IPriceSource.sol";
import {Trustees} from "../governance/Trustees.sol";

/**
 * @title PegDefenseHook
 * @notice V4 hook attached to the MONEY/cbETH pool. Does two jobs:
 *
 *           1. **Observation recording** — accumulates tick * time on every swap, exposing
 *              `getCurrentTickCumulative()` via the IPriceSource interface so our Oracle
 *              can compute a TWAP without relying on a separate observation contract.
 *
 *           2. **Dynamic LP fee** — overrides the pool's swap fee on every beforeSwap based
 *              on how far the current tick is from the configured peg tick. Above peg
 *              (expansion): low fee, encourages buying. Near peg: base fee. Below peg
 *              (contraction): high fee, discourages selling. Deep below peg: even higher.
 *
 * @dev    This is the single approved hook-driven deviation from Tomb's design. Tomb's
 *         TaxOffice + tax tiers + transferFrom override are entirely replaced by this hook.
 *         Tomb taxed all transfers; we tax only pool swaps. Wallet-to-wallet MONEY transfers
 *         see no friction.
 *
 *         Sprint 4 scope: observation recording + dynamic fee override.
 *         Sprint 4b (deferred): sell tax with returnDelta routing to Treasury.
 *
 *         Hook permissions: afterInitialize (capture pool state), beforeSwap (observe + fee).
 *         The deployed address must have low-14-bit pattern 0x1080
 *         (AFTER_INITIALIZE_FLAG | BEFORE_SWAP_FLAG).
 */
contract PegDefenseHook is BaseV4Hook, Trustees, IPriceSource {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using LPFeeLibrary for uint24;

    /// @notice The MONEY token. The hook expects to be installed on a pool where one side
    ///         is MONEY and the other is the paired peg asset (cbETH on Base).
    address public immutable money;

    /// @notice True if MONEY sorts as currency0 in the pool key. Derived in afterInitialize.
    bool public moneyIsCurrency0;

    /// @notice Set in afterInitialize. Used to read the live pool state and to validate
    ///         subsequent hook calls.
    PoolId public poolId;

    /// @notice True after afterInitialize has bound the hook to a pool. Single-pool design.
    bool public bound;

    /// @notice The configured peg tick. Default 0 == 1:1 price ratio. Trustees-settable.
    int24 public pegTick;

    /// @notice Half-width of the "near peg" band, in ticks. Outside this band, fees scale up.
    int24 public bandTicks = 100; // ~1% wide

    /// @notice Fee tiers, in V4 pip units (1e6 == 100%). Trustees-settable.
    /// @dev Defaults mirror what a Tomb-style algo-stable might charge:
    ///        - expansion: 10 bps (0.10%)
    ///        - base:      30 bps (0.30%)
    ///        - contraction: 100 bps (1.00%)
    ///        - deep contraction: 300 bps (3.00%)
    uint24 public expansionFee = 1000;
    uint24 public baseFee = 3000;
    uint24 public contractionFee = 10_000;
    uint24 public deepContractionFee = 30_000;

    // Observation state (Tomb-V2 equivalent).
    int56 public tickCumulative;
    uint32 public lastObservationTimestamp;
    int24 public lastTick;

    // --- Events ---
    event Bound(PoolId indexed poolId, bool moneyIsCurrency0, int24 initialTick);
    event Observed(int56 tickCumulative, int24 lastTick, uint32 timestamp);
    event PegTickSet(int24 previous, int24 next);
    event BandTicksSet(int24 previous, int24 next);
    event FeesSet(uint24 expansionFee, uint24 baseFee, uint24 contractionFee, uint24 deepContractionFee);

    // --- Errors ---
    error AlreadyBound();
    error UnknownPool();
    error PoolMissingMoney();
    error FeeTooHigh();
    error BandTicksMustBePositive();

    constructor(
        IPoolManager _poolManager,
        address _money
    ) BaseV4Hook(_poolManager) {
        money = _money;
    }

    // ------------------------------------------------------------------
    // BaseV4Hook overrides
    // ------------------------------------------------------------------

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: false,
            afterInitialize: true,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function afterInitialize(
        address, /* sender */
        PoolKey calldata key,
        uint160, /* sqrtPriceX96 */
        int24 tick
    ) external override onlyPoolManager returns (bytes4) {
        if (bound) revert AlreadyBound();
        if (Currency.unwrap(key.currency0) != money && Currency.unwrap(key.currency1) != money) {
            revert PoolMissingMoney();
        }

        moneyIsCurrency0 = Currency.unwrap(key.currency0) == money;
        poolId = key.toId();
        lastTick = tick;
        lastObservationTimestamp = uint32(block.timestamp);
        bound = true;

        emit Bound(poolId, moneyIsCurrency0, tick);
        return IHooks.afterInitialize.selector;
    }

    function beforeSwap(
        address, /* sender */
        PoolKey calldata key,
        SwapParams calldata, /* params */
        bytes calldata /* hookData */
    ) external override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        if (!bound) revert UnknownPool();
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(poolId)) revert UnknownPool();

        // Read live tick from the pool, then fold it into the cumulative.
        (, int24 currentTick,,) = poolManager.getSlot0(poolId);
        _accumulate(currentTick);

        uint24 fee = _feeForTick(currentTick);
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    // ------------------------------------------------------------------
    // IPriceSource — Oracle reads from here
    // ------------------------------------------------------------------

    /// @inheritdoc IPriceSource
    function getCurrentTickCumulative() external view returns (int56 cumulative, uint32 blockTimestamp) {
        blockTimestamp = uint32(block.timestamp);
        if (!bound) return (0, blockTimestamp);
        uint32 dt = blockTimestamp - lastObservationTimestamp;
        cumulative = tickCumulative + int56(lastTick) * int56(uint56(dt));
    }

    // ------------------------------------------------------------------
    // Trustees-governed parameters
    // ------------------------------------------------------------------

    /// @notice Re-target the peg tick. Default 0 = price 1.0. Trustees-only.
    function setPegTick(
        int24 newPegTick
    ) external onlyTrustees {
        emit PegTickSet(pegTick, newPegTick);
        pegTick = newPegTick;
    }

    /// @notice Set the "near peg" band half-width. Trustees-only.
    function setBandTicks(
        int24 newBandTicks
    ) external onlyTrustees {
        if (newBandTicks <= 0) revert BandTicksMustBePositive();
        emit BandTicksSet(bandTicks, newBandTicks);
        bandTicks = newBandTicks;
    }

    /// @notice Update the four fee tiers. Each must be <= MAX_LP_FEE (1e6). Trustees-only.
    function setFees(
        uint24 _expansionFee,
        uint24 _baseFee,
        uint24 _contractionFee,
        uint24 _deepContractionFee
    ) external onlyTrustees {
        if (
            _expansionFee > LPFeeLibrary.MAX_LP_FEE || _baseFee > LPFeeLibrary.MAX_LP_FEE
                || _contractionFee > LPFeeLibrary.MAX_LP_FEE || _deepContractionFee > LPFeeLibrary.MAX_LP_FEE
        ) revert FeeTooHigh();
        expansionFee = _expansionFee;
        baseFee = _baseFee;
        contractionFee = _contractionFee;
        deepContractionFee = _deepContractionFee;
        emit FeesSet(_expansionFee, _baseFee, _contractionFee, _deepContractionFee);
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    function _accumulate(
        int24 currentTick
    ) internal {
        uint32 nowTs = uint32(block.timestamp);
        uint32 dt = nowTs - lastObservationTimestamp;
        if (dt > 0) {
            tickCumulative += int56(lastTick) * int56(uint56(dt));
        }
        lastTick = currentTick;
        lastObservationTimestamp = nowTs;
        emit Observed(tickCumulative, currentTick, nowTs);
    }

    /// @dev Map current tick to a fee tier based on signed deviation from `pegTick`.
    ///      "Below peg" is direction-aware: when MONEY is currency0, below peg means
    ///      currentTick < pegTick (price of MONEY in cbETH dropped). When MONEY is
    ///      currency1, the sign flips.
    function _feeForTick(
        int24 currentTick
    ) internal view returns (uint24) {
        // Signed delta in the direction that makes "negative = MONEY below peg".
        int24 delta = moneyIsCurrency0 ? currentTick - pegTick : pegTick - currentTick;

        if (delta >= bandTicks) {
            return expansionFee;
        }
        if (delta > -bandTicks) {
            return baseFee;
        }
        if (delta > -2 * bandTicks) {
            return contractionFee;
        }
        return deepContractionFee;
    }
}
