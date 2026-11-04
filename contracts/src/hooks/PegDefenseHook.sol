// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BaseV4Hook} from "./base/BaseV4Hook.sol";
import {IPriceSource} from "../interfaces/IPriceSource.sol";
import {Trustees} from "../governance/Trustees.sol";

/// @dev Minimal interface used to invoke the public `burn(uint256)` on $MONEY (OldMoney).
///      Defined inline so this hook doesn't take a hard import dependency on the token.
interface IBurnable {
    function burn(
        uint256 amount
    ) external;
}

/**
 * @title PegDefenseHook
 * @notice V4 hook attached to the MONEY/WETH pool. Three jobs:
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
 *           3. **Tomb-style sell tax with burn-during-contraction (Sprint 4b)** — on sells
 *              of MONEY, takes a slice of the user's MONEY input via `BeforeSwapDelta`,
 *              pulls it into the hook via `poolManager.take`, and either burns (price <
 *              `burnThreshold`) or transfers to Treasury (price >= burnThreshold). The 14
 *              tier prices + rates and the default `burnThreshold = 1.10e18` match Tomb's
 *              Bomb.sol exactly. `autoCalculateTax` is off by default (Tomb pattern);
 *              Trustees flips it on post-launch.
 *
 * @dev    This is the single approved hook-driven deviation from Tomb's design. Tomb's
 *         TaxOffice + tax tiers + transferFrom override are entirely replaced by this hook.
 *         Tomb taxed all transfers symmetrically; we tax only sells through the V4 pool
 *         (the economic intent was always sell-side — Tomb's symmetry was a side-effect of
 *         intercepting transferFrom). Wallet-to-wallet MONEY transfers see no friction.
 *
 *         Hook permissions: afterInitialize (capture pool state), beforeSwap (observe +
 *         fee + tax). Low-14-bit pattern = 0x1088:
 *           AFTER_INITIALIZE      = 0x1000
 *           BEFORE_SWAP           = 0x0080
 *           BEFORE_SWAP_RETURN_Δ  = 0x0008
 *
 *         For the contract design rationale and tier-table justification, see
 *         docs/HOOK_TAX_DESIGN.md.
 */
contract PegDefenseHook is BaseV4Hook, Trustees, IPriceSource {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using LPFeeLibrary for uint24;
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Immutables / pool binding
    // ------------------------------------------------------------------

    /// @notice The MONEY token. The hook expects to be installed on a pool where one side
    ///         is MONEY and the other is the paired peg asset (WETH on Base).
    address public immutable money;

    /// @notice True if MONEY sorts as currency0 in the pool key. Derived in afterInitialize.
    bool public moneyIsCurrency0;

    /// @notice Set in afterInitialize. Used to read the live pool state and to validate
    ///         subsequent hook calls.
    PoolId public poolId;

    /// @notice True after afterInitialize has bound the hook to a pool. Single-pool design.
    bool public bound;

    // ------------------------------------------------------------------
    // Dynamic-fee state (Sprint 4)
    // ------------------------------------------------------------------

    /// @notice The configured peg tick. Default 0 == 1:1 price ratio. Trustees-settable.
    int24 public pegTick;

    /// @notice Half-width of the "near peg" band, in ticks. Outside this band, fees scale up.
    int24 public bandTicks = 100; // ~1% wide

    /// @notice Fee tiers, in V4 pip units (1e6 == 100%). Trustees-settable.
    uint24 public expansionFee = 1000;
    uint24 public baseFee = 3000;
    uint24 public contractionFee = 10_000;
    uint24 public deepContractionFee = 30_000;

    // ------------------------------------------------------------------
    // Observation state (Tomb-V2 equivalent)
    // ------------------------------------------------------------------

    int56 public tickCumulative;
    uint32 public lastObservationTimestamp;
    int24 public lastTick;

    // ------------------------------------------------------------------
    // Tax state (Sprint 4b — Tomb-faithful)
    // ------------------------------------------------------------------

    /// @notice Master switch — when false, no tax is applied regardless of price. Trustees-
    ///         settable. Off by default to match Tomb's launch pattern (operator enables
    ///         after the protocol is stable).
    bool public autoCalculateTax;

    /// @notice Price thresholds (1e18-scaled MONEY/WETH ratio) defining the 14 tax tiers.
    ///         Walked high → low; first one a price exceeds sets the rate.
    uint256[] public taxTiersTwaps;

    /// @notice Tax rate in basis points per tier. Same length as `taxTiersTwaps`.
    uint256[] public taxTiersRates;

    /// @notice Below this price (1e18-scaled), the tax slice is BURNED. At or above, it's
    ///         transferred to `treasury`. Defaults to 1.10e18 per Tomb.
    uint256 public burnThreshold = 1.1e18;

    /// @notice Address that receives tax when `price >= burnThreshold`. Zero address means
    ///         no destination; tax falls through to burn even above the threshold (safe
    ///         default before Trustees sets the real Treasury post-deploy).
    address public treasury;

    /// @notice Sender addresses exempt from the tax. Trustees-settable. Used for protocol
    ///         contracts that need to interact with the pool without triggering the tax
    ///         (e.g., LP wrappers, future POL machinery).
    mapping(address => bool) public excludedAddresses;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event Bound(PoolId indexed poolId, bool moneyIsCurrency0, int24 initialTick);
    event Observed(int56 tickCumulative, int24 lastTick, uint32 timestamp);
    event PegTickSet(int24 previous, int24 next);
    event BandTicksSet(int24 previous, int24 next);
    event FeesSet(uint24 expansionFee, uint24 baseFee, uint24 contractionFee, uint24 deepContractionFee);

    // Sprint 4b
    event AutoCalculateTaxSet(bool enabled);
    event BurnThresholdSet(uint256 previous, uint256 next);
    event TreasurySet(address indexed previous, address indexed next);
    event TaxTierSet(uint256 indexed index, uint256 twap, uint256 rate);
    event AddressExclusionSet(address indexed account, bool excluded);
    event TaxBurned(uint256 amount, uint256 price);
    event TaxRouted(address indexed treasury, uint256 amount, uint256 price);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error AlreadyBound();
    error UnknownPool();
    error PoolMissingMoney();
    error FeeTooHigh();
    error BandTicksMustBePositive();

    // Sprint 4b
    error TierIndexOutOfRange();
    error NonMonotonicTier();
    error TaxRateTooHigh();
    error BurnThresholdZero();

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    constructor(
        IPoolManager _poolManager,
        address _money,
        address _initialTrustees
    ) BaseV4Hook(_poolManager) Trustees(_initialTrustees) {
        money = _money;

        // Tomb-faithful tier table (matches Bomb.sol exactly).
        taxTiersTwaps = [
            uint256(0),
            0.5e18,
            0.6e18,
            0.7e18,
            0.8e18,
            0.9e18,
            0.95e18,
            1.0e18,
            1.05e18,
            1.1e18,
            1.2e18,
            1.3e18,
            1.4e18,
            1.5e18
        ];
        taxTiersRates = [uint256(2000), 1900, 1800, 1700, 1600, 1500, 1500, 1500, 1500, 1400, 900, 400, 200, 100];
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
            beforeSwapReturnDelta: true, // Sprint 4b — enables tax slice via BeforeSwapDelta
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function afterInitialize(
        address sender,
        PoolKey calldata key,
        uint160, /* sqrtPriceX96 */
        int24 tick
    ) external override onlyPoolManager returns (bytes4) {
        if (bound) revert AlreadyBound();
        if (sender != trustees()) revert NotTrustees();
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
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata /* hookData */
    ) external override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        if (!bound) revert UnknownPool();
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(poolId)) revert UnknownPool();

        // Read live tick from the pool, then fold it into the cumulative.
        // slither-disable-next-line unused-return — only the tick is needed from slot0.
        (, int24 currentTick,,) = poolManager.getSlot0(poolId);
        _accumulate(currentTick);

        uint24 fee = _feeForTick(currentTick) | LPFeeLibrary.OVERRIDE_FEE_FLAG;

        // ------------------------------------------------------------------
        // Sprint 4b tax slice
        // ------------------------------------------------------------------
        // Fast paths that skip the tax entirely:
        //   - tax not enabled
        //   - swap is a BUY (WETH → MONEY) — never tax buys
        //   - sender is excluded
        if (!autoCalculateTax) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee);
        }
        bool isSell = (moneyIsCurrency0 == params.zeroForOne);
        if (!isSell) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee);
        }
        if (excludedAddresses[sender]) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee);
        }

        uint256 price = _priceFromTick(currentTick);
        uint256 rate = _taxRateForPrice(price);
        if (rate == 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee);
        }

        // Compute tax slice from the MONEY-side amount. For exact-input swaps
        // (amountSpecified < 0), the specified token IS MONEY (the input) and we
        // return deltaSpecified > 0. For exact-output swaps (amountSpecified > 0),
        // the specified token is WETH (output) and MONEY is the unspecified side;
        // we return deltaUnspecified > 0.
        uint256 absAmount =
            params.amountSpecified < 0 ? uint256(-params.amountSpecified) : uint256(params.amountSpecified);
        uint256 taxAmount = absAmount * rate / 10_000;
        if (taxAmount == 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee);
        }

        BeforeSwapDelta delta;
        if (params.amountSpecified < 0) {
            // Exact-input: MONEY is the specified token.
            delta = toBeforeSwapDelta(int128(int256(taxAmount)), int128(0));
        } else {
            // Exact-output: MONEY is the unspecified (input) token.
            delta = toBeforeSwapDelta(int128(0), int128(int256(taxAmount)));
        }

        // Pull the tax MONEY into the hook's balance. The take call settles the
        // hook's credit with the PoolManager.
        Currency moneyCurrency = moneyIsCurrency0 ? key.currency0 : key.currency1;
        poolManager.take(moneyCurrency, address(this), taxAmount);

        // Burn below threshold, route above. Below-threshold burn is the
        // load-bearing deflationary lever during contraction.
        if (price < burnThreshold) {
            IBurnable(money).burn(taxAmount);
            emit TaxBurned(taxAmount, price);
        } else if (treasury != address(0)) {
            IERC20(money).safeTransfer(treasury, taxAmount);
            emit TaxRouted(treasury, taxAmount, price);
        } else {
            // Treasury unset; fall through to burn for safety. Trustees should set
            // a treasury before flipping autoCalculateTax on.
            IBurnable(money).burn(taxAmount);
            emit TaxBurned(taxAmount, price);
        }

        return (IHooks.beforeSwap.selector, delta, fee);
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
    // Trustees-governed parameters — Sprint 4 (dynamic fee)
    // ------------------------------------------------------------------

    function setPegTick(
        int24 newPegTick
    ) external onlyTrustees {
        emit PegTickSet(pegTick, newPegTick);
        pegTick = newPegTick;
    }

    function setBandTicks(
        int24 newBandTicks
    ) external onlyTrustees {
        if (newBandTicks <= 0) revert BandTicksMustBePositive();
        emit BandTicksSet(bandTicks, newBandTicks);
        bandTicks = newBandTicks;
    }

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
    // Trustees-governed parameters — Sprint 4b (tax)
    // ------------------------------------------------------------------

    function setAutoCalculateTax(
        bool enabled
    ) external onlyTrustees {
        autoCalculateTax = enabled;
        emit AutoCalculateTaxSet(enabled);
    }

    function setBurnThreshold(
        uint256 newBurnThreshold
    ) external onlyTrustees {
        if (newBurnThreshold == 0) revert BurnThresholdZero();
        emit BurnThresholdSet(burnThreshold, newBurnThreshold);
        burnThreshold = newBurnThreshold;
    }

    function setTreasury(
        address newTreasury
    ) external onlyTrustees {
        emit TreasurySet(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Update a single tier's price threshold. Preserves monotonicity.
    function setTaxTiersTwap(
        uint256 index,
        uint256 newTwap
    ) external onlyTrustees {
        if (index >= taxTiersTwaps.length) revert TierIndexOutOfRange();
        if (index > 0 && newTwap <= taxTiersTwaps[index - 1]) revert NonMonotonicTier();
        if (index < taxTiersTwaps.length - 1 && newTwap >= taxTiersTwaps[index + 1]) revert NonMonotonicTier();
        taxTiersTwaps[index] = newTwap;
        emit TaxTierSet(index, newTwap, taxTiersRates[index]);
    }

    /// @notice Update a single tier's rate. Bounded to 10000 (100%) to prevent rug-via-tax.
    function setTaxTiersRate(
        uint256 index,
        uint256 newRate
    ) external onlyTrustees {
        if (index >= taxTiersRates.length) revert TierIndexOutOfRange();
        if (newRate > 10_000) revert TaxRateTooHigh();
        taxTiersRates[index] = newRate;
        emit TaxTierSet(index, taxTiersTwaps[index], newRate);
    }

    function setExcludedAddress(
        address account,
        bool excluded
    ) external onlyTrustees {
        excludedAddresses[account] = excluded;
        emit AddressExclusionSet(account, excluded);
    }

    // ------------------------------------------------------------------
    // View helpers
    // ------------------------------------------------------------------

    function getTaxTiersTwapsCount() external view returns (uint256) {
        return taxTiersTwaps.length;
    }

    function getTaxTiersRatesCount() external view returns (uint256) {
        return taxTiersRates.length;
    }

    /// @notice Compute the 1e18-scaled MONEY/WETH price at a given tick.
    function priceFromTick(
        int24 tick
    ) external view returns (uint256) {
        return _priceFromTick(tick);
    }

    /// @notice Look up the tax rate (bps) that would apply at a given 1e18-scaled price.
    function taxRateForPrice(
        uint256 price
    ) external view returns (uint256) {
        return _taxRateForPrice(price);
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
    function _feeForTick(
        int24 currentTick
    ) internal view returns (uint24) {
        int24 delta = moneyIsCurrency0 ? currentTick - pegTick : pegTick - currentTick;
        if (delta >= bandTicks) return expansionFee;
        if (delta > -bandTicks) return baseFee;
        if (delta > -2 * bandTicks) return contractionFee;
        return deepContractionFee;
    }

    /// @dev Convert a tick to a 1e18-scaled MONEY/WETH price. Uses two FullMath.mulDiv
    ///      steps to avoid a 512-bit-product overflow at high-tick magnitudes.
    function _priceFromTick(
        int24 tick
    ) internal view returns (uint256 price) {
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        if (moneyIsCurrency0) {
            // MONEY is currency0 → price (1e18 scaled) = sqrtP^2 / 2^192 * 1e18.
            // Two mulDiv passes: first divides by 2^96, second multiplies by 1e18/2^96.
            uint256 stage = FullMath.mulDiv(uint256(sqrtP), uint256(sqrtP), 1 << 96);
            price = FullMath.mulDiv(stage, 1e18, 1 << 96);
        } else {
            // MONEY is currency1 → price = 2^192 / sqrtP^2 * 1e18.
            uint256 stage = FullMath.mulDiv(1 << 96, 1e18, uint256(sqrtP));
            price = FullMath.mulDiv(stage, 1 << 96, uint256(sqrtP));
        }
    }

    /// @dev Walk tier table high → low; first one `price` exceeds sets the rate. Matches
    ///      Tomb's `_updateTaxRate` semantic exactly. Returns 0 if no tier matches
    ///      (impossible with sorted array starting at 0; defensive default).
    function _taxRateForPrice(
        uint256 price
    ) internal view returns (uint256) {
        uint256 len = taxTiersTwaps.length;
        for (uint256 i = len; i > 0;) {
            unchecked {
                --i;
            }
            if (price >= taxTiersTwaps[i]) return taxTiersRates[i];
        }
        return 0;
    }
}
