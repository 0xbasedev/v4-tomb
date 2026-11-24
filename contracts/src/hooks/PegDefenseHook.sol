// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary, toBeforeSwapDelta} from "v4-core/src/types/BeforeSwapDelta.sol";
import {Currency, CurrencyLibrary} from "v4-core/src/types/Currency.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BaseV4Hook} from "./base/BaseV4Hook.sol";
import {IPriceSource} from "../interfaces/IPriceSource.sol";
import {IOracle} from "../interfaces/IOracle.sol";
import {Trustees} from "../governance/Trustees.sol";

/// @dev Minimal interface used to invoke the public `burn(uint256)` on $PEG (PegToken).
///      Defined inline so this hook doesn't take a hard import dependency on the token.
interface IBurnable {
    function burn(
        uint256 amount
    ) external;
}

/// @notice The low-14-bit address pattern PegDefenseHook must be deployed at. Deploy scripts
///         and tests mine their CREATE2 salt against this single definition.
library PegDefenseHookPermissions {
    uint160 internal constant FLAGS = uint160(
        Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );
}

/**
 * @title PegDefenseHook
 * @notice V4 hook attached to the PEG/WETH pool. Three jobs:
 *
 *           1. **Observation recording** — integrates tick * time across swaps, exposing
 *              `getCurrentTickCumulative()` via the IPriceSource interface so our Oracle
 *              can compute a TWAP without relying on a separate observation contract.
 *              `beforeSwap` folds the time the pool spent resting at the previous tick;
 *              `afterSwap` records the tick the swap left behind. Recording only the
 *              pre-swap tick would leave the oracle one swap stale, and would let a
 *              same-block pump-and-dump park an arbitrary tick in the accumulator.
 *
 *           2. **Dynamic LP fee** — overrides the pool's swap fee on every beforeSwap based
 *              on how far the current tick is from the configured peg tick. Above peg
 *              (expansion): low fee, encourages buying. Near peg: base fee. Below peg
 *              (contraction): high fee, discourages selling. Deep below peg: even higher.
 *
 *           3. **Fire Tax — sell tax keyed to the TWAP, with burn-during-contraction** —
 *              sells of PEG pay a PEG-denominated tax. The schedule steps DOWN as the
 *              peg strengthens, and can never exceed `MAX_TAX_BPS` (12%):
 *
 *                  TWAP <  1.12   → 12%
 *                  TWAP >= 1.12   →  6%
 *                  TWAP >= 1.20   →  3%
 *
 *              The schedule is a TARGET. The rate actually charged (`taxRate`) ratchets:
 *              it rises to a higher target immediately, but only falls once a lower
 *              target has stood for `TAX_RECOVERY_PERIOD` (7 hours). See `_nextTaxState`.
 *
 *              The price used is the Oracle's last completed epoch TWAP (`taxOracle`),
 *              not the pool's spot price. Until an oracle is wired and has completed its
 *              first epoch, the pre-swap spot price is the fallback. The tax is burned
 *              (price < `burnThreshold`) or sent to the fee recipient (price >= threshold).
 *              `autoCalculateTax` is off by default; Trustees flips it on post-launch.
 *
 *              Both swap modes charge the same effective rate `r` on the seller's gross
 *              PEG outlay `G`:
 *                - exact-input  (PEG is the specified token): assessed in `beforeSwap`,
 *                  `tax = G * r`, and the pool swaps `G - tax`.
 *                - exact-output (PEG is the unspecified token): the PEG the pool needs
 *                  (`N`) is only known after the swap, so it is assessed in `afterSwap` as
 *                  `tax = N * r / (1 - r)`, which makes `tax / (N + tax) == r`.
 *
 * @dev    This is the single approved hook-driven deviation from Tomb's design. Tomb's
 *         TaxOffice + tax tiers + transferFrom override are entirely replaced by this hook.
 *         Tomb taxed all transfers symmetrically; we tax only sells through the V4 pool
 *         (the economic intent was always sell-side — Tomb's symmetry was a side-effect of
 *         intercepting transferFrom). Wallet-to-wallet PEG transfers see no friction, and
 *         PEG traded in any OTHER pool is outside this hook's reach by design.
 *
 *         Hook permissions — low-14-bit pattern = 0x10CC (see `PERMISSION_FLAGS`):
 *           AFTER_INITIALIZE      = 0x1000
 *           BEFORE_SWAP           = 0x0080
 *           AFTER_SWAP            = 0x0040
 *           BEFORE_SWAP_RETURN_Δ  = 0x0008
 *           AFTER_SWAP_RETURN_Δ   = 0x0004
 *
 *         For the contract design rationale and tier-table justification, see
 *         docs/HOOK_TAX_DESIGN.md.
 */
contract PegDefenseHook is BaseV4Hook, Trustees, IPriceSource, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using LPFeeLibrary for uint24;
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @notice The permission bits this hook's deployed address must carry.
    uint160 public constant PERMISSION_FLAGS = PegDefenseHookPermissions.FLAGS;

    uint256 internal constant BPS = 10_000;

    /// @notice Hard ceiling on the sell tax. No setter, tier or rate path can exceed it.
    uint256 public constant MAX_TAX_BPS = 1200;

    /// @notice How long a lower target rate must stand before `taxRate` may fall to it.
    uint256 public constant TAX_RECOVERY_PERIOD = 7 hours;

    // ------------------------------------------------------------------
    // Immutables / pool binding
    // ------------------------------------------------------------------

    /// @notice The PEG token. The hook expects to be installed on a pool where one side
    ///         is PEG and the other is the paired peg asset (WETH on Base).
    address public immutable peg;

    /// @notice True if PEG sorts as currency0 in the pool key. Derived in afterInitialize.
    bool public pegIsCurrency0;

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

    /// @notice Price thresholds (1e18-scaled WETH per PEG) defining the tax tiers.
    ///         Walked high → low; the first one the tax price reaches sets the rate.
    uint256[] public taxTiersTwaps;

    /// @notice Target tax rate in basis points per tier. Same length as `taxTiersTwaps`.
    ///         Every entry is bounded by `MAX_TAX_BPS`.
    uint256[] public taxTiersRates;

    /// @notice The sell-tax rate (bps) in force as of the last sync. Starts at the maximum,
    ///         so a fresh deployment charges 12% until a lower rate has been earned.
    uint16 public taxRate = uint16(MAX_TAX_BPS);

    /// @notice The lower rate `taxRate` will fall to once the recovery period has run.
    ///         Meaningful only while `taxRecoveryStartedAt != 0`.
    uint16 public taxRecoveryRate;

    /// @notice When the current recovery window opened. Zero when no decrease is pending.
    uint40 public taxRecoveryStartedAt;

    /// @notice Lifetime tax accounting. At all times:
    ///           totalTaxAssessed == totalTaxBurned + totalTaxRouted
    ///                               + pendingTaxBurn + pendingTaxRoute
    ///         and the hook's ERC-6909 PEG claims on the PoolManager cover the two
    ///         pending amounts in full.
    uint256 public totalTaxAssessed;
    uint256 public totalTaxBurned;
    uint256 public totalTaxRouted;

    /// @notice Below this price (1e18-scaled), the tax slice is BURNED. At or above, it's
    ///         transferred to `feeRecipient`. Defaults to 1.10e18 per Tomb.
    uint256 public burnThreshold = 1.1e18;

    /// @notice Source of the TWAP the tax tier and burn threshold are read against.
    ///         `consult(peg, 1e18)` must return WETH per PEG, 1e18-scaled. While unset,
    ///         or while it reports zero (no completed epoch yet) or reverts, the pool's
    ///         pre-swap spot price is used instead.
    IOracle public taxOracle;

    /// @notice Address that receives tax when `price >= burnThreshold`. Zero address means
    ///         no destination; tax falls through to burn even above the threshold (safe
    ///         default before Trustees sets the real Treasury post-deploy).
    address public feeRecipient;

    /// @notice Sender addresses exempt from the tax. Trustees-settable. Used for protocol
    ///         contracts that need to interact with the pool without triggering the tax
    ///         (e.g., LP wrappers, future POL machinery).
    ///
    ///         CAUTION: V4 passes the hook the address that called `PoolManager.swap` — the
    ///         ROUTER, not the end user. Excluding a router exempts every trader who uses
    ///         it. Only exclude single-purpose protocol contracts that swap for themselves.
    mapping(address => bool) public excludedAddresses;

    /// @notice Tax owed to the burn that could not be pulled out of the PoolManager at swap
    ///         time. Held as ERC-6909 PEG claims on the PoolManager until
    ///         `settleDeferredTax` redeems them. See `_collectTax`.
    uint256 public pendingTaxBurn;

    /// @notice As `pendingTaxBurn`, for tax owed to the fee recipient.
    uint256 public pendingTaxRoute;

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event Bound(PoolId indexed poolId, bool pegIsCurrency0, int24 initialTick);
    event Observed(int56 tickCumulative, int24 lastTick, uint32 timestamp);
    event PegTickSet(int24 previous, int24 next);
    event BandTicksSet(int24 previous, int24 next);
    event FeesSet(uint24 expansionFee, uint24 baseFee, uint24 contractionFee, uint24 deepContractionFee);

    // Sprint 4b
    event AutoCalculateTaxSet(bool enabled);
    event BurnThresholdSet(uint256 previous, uint256 next);
    event FeeRecipientSet(address indexed previous, address indexed next);
    event TaxOracleSet(address indexed previous, address indexed next);
    event TaxRateChanged(uint256 previous, uint256 next);
    event TaxRecoveryStarted(uint256 fromRate, uint256 toRate, uint256 readyAt);
    event TaxTierSet(uint256 indexed index, uint256 twap, uint256 rate);
    event AddressExclusionSet(address indexed account, bool excluded);
    event TaxBurned(uint256 amount, uint256 price);
    event TaxRouted(address indexed feeRecipient, uint256 amount, uint256 price);
    event TaxDeferred(uint256 amount, bool toBurn, uint256 price);
    event DeferredTaxSettled(uint256 burned, uint256 routed);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error AlreadyBound();
    error UnknownPool();
    error PoolMissingPeg();
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
        address _peg,
        address _initialTrustees
    ) BaseV4Hook(_poolManager) {
        peg = _peg;

        // Override the Trustees() base-constructor's msg.sender assignment. Required for
        // CREATE2-via-broadcast deploys (e.g., `new Hook{salt:}(...)` inside
        // `vm.startBroadcast`) where msg.sender of the constructor is the canonical
        // deployer (0x4e59...) rather than the human deployer we want as administrator.
        // Direct-deploy callers (tests using `deployCodeTo`, inline-assembly `create2`
        // from a test contract) should pass `msg.sender` / `address(this)` to preserve
        // the prior default behavior.
        _transferTrustees(_initialTrustees); // reverts on zero address (ZeroTrusteesAddress)
        _transferOwnership(_initialTrustees);

        // 12% below 1.12, 6% from 1.12, 3% from 1.20.
        taxTiersTwaps = [uint256(0), 1.12e18, 1.2e18];
        taxTiersRates = [uint256(1200), 600, 300];
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
            afterSwap: true, // records the post-swap tick; taxes exact-output sells
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true, // exact-input sell tax (PEG is the specified token)
            afterSwapReturnDelta: true, // exact-output sell tax (PEG is the unspecified token)
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
        if (Currency.unwrap(key.currency0) != peg && Currency.unwrap(key.currency1) != peg) {
            revert PoolMissingPeg();
        }

        pegIsCurrency0 = Currency.unwrap(key.currency0) == peg;
        poolId = key.toId();
        lastTick = tick;
        lastObservationTimestamp = uint32(block.timestamp);
        bound = true;

        emit Bound(poolId, pegIsCurrency0, tick);
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

        if (!autoCalculateTax) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee);
        }

        // Advance the Fire Tax ratchet on every swap — buys included — so recovery
        // windows open and close on time even when nobody is selling.
        uint256 price = _taxPrice(currentTick);
        uint256 rate = _syncTaxRate(price);

        // ------------------------------------------------------------------
        // Sell tax — exact-input leg. Exact-output sells are assessed in afterSwap, once
        // the PEG amount is known. `amountSpecified` is PEG only when it is negative.
        // ------------------------------------------------------------------
        if (params.amountSpecified >= 0 || !_isTaxedSell(sender, params.zeroForOne)) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee);
        }

        uint256 taxAmount = uint256(-params.amountSpecified) * rate / BPS;
        if (taxAmount == 0) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee);
        }

        _collectTax(taxAmount, price);

        // Positive specified delta: the hook is owed `taxAmount` of the input, and the pool
        // swaps the remainder.
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(taxAmount.toInt128(), int128(0)), fee);
    }

    function afterSwap(
        address sender,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata /* hookData */
    ) external override onlyPoolManager returns (bytes4, int128) {
        if (!bound) revert UnknownPool();
        if (PoolId.unwrap(key.toId()) != PoolId.unwrap(poolId)) revert UnknownPool();

        // beforeSwap left `lastTick` at the pre-swap tick. Keep it for the tax fallback, then
        // record where the swap actually left the pool so idle time accrues at that tick.
        int24 preSwapTick = lastTick;
        // slither-disable-next-line unused-return — only the tick is needed from slot0.
        (, int24 postSwapTick,,) = poolManager.getSlot0(poolId);
        lastTick = postSwapTick;
        emit Observed(tickCumulative, postSwapTick, lastObservationTimestamp);

        // ------------------------------------------------------------------
        // Sell tax — exact-output leg.
        // ------------------------------------------------------------------
        if (params.amountSpecified <= 0 || !_isTaxedSell(sender, params.zeroForOne)) {
            return (IHooks.afterSwap.selector, 0);
        }

        // beforeSwap already synced the ratchet for this swap; `taxRate` <= MAX_TAX_BPS,
        // so the gross-up below is always well defined.
        uint256 rate = taxRate;
        if (rate == 0) return (IHooks.afterSwap.selector, 0);
        uint256 price = _taxPrice(preSwapTick);

        // The pool's PEG leg is negative from the swapper's side: they owe it.
        int128 pegDelta = pegIsCurrency0 ? delta.amount0() : delta.amount1();
        if (pegDelta >= 0) return (IHooks.afterSwap.selector, 0);
        uint256 netIn = uint256(uint128(-pegDelta));

        // Rounded up so the effective rate never falls below the tier rate.
        uint256 taxAmount = FullMath.mulDivRoundingUp(netIn, rate, BPS - rate);

        _collectTax(taxAmount, price);

        // Positive unspecified delta: the swapper owes `taxAmount` more PEG on top of
        // what the pool took. Routers enforce this against the caller's max-input bound.
        return (IHooks.afterSwap.selector, taxAmount.toInt128());
    }

    // ------------------------------------------------------------------
    // Deferred tax settlement
    // ------------------------------------------------------------------

    /// @notice Redeem tax that was parked as PoolManager claims (see `_collectTax`) and
    ///         burn / route it. Permissionless: it only ever moves value to the burn or to
    ///         the fee recipient. Settles as much as the PoolManager's PEG reserves allow,
    ///         burn first, and never reverts for lack of reserves — a call that can settle
    ///         nothing is a no-op, so it is safe to retry on any schedule.
    /// @return burned PEG burned by this call.
    /// @return routed PEG sent to the fee recipient by this call.
    function settleDeferredTax() external returns (uint256 burned, uint256 routed) {
        if (pendingTaxBurn + pendingTaxRoute == 0) return (0, 0);
        if (IERC20(peg).balanceOf(address(poolManager)) == 0) return (0, 0);
        return abi.decode(poolManager.unlock(""), (uint256, uint256));
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(
        bytes calldata /* data */
    ) external onlyPoolManager returns (bytes memory) {
        uint256 available = IERC20(peg).balanceOf(address(poolManager));
        uint256 fromBurn = pendingTaxBurn < available ? pendingTaxBurn : available;
        available -= fromBurn;
        uint256 fromRoute = pendingTaxRoute < available ? pendingTaxRoute : available;
        uint256 total = fromBurn + fromRoute;
        if (total == 0) return abi.encode(uint256(0), uint256(0));

        // A fee recipient that was unset since the tax was deferred falls back to the burn.
        address dest = feeRecipient;
        uint256 toBurn = dest == address(0) ? total : fromBurn;
        uint256 toRoute = total - toBurn;

        pendingTaxBurn -= fromBurn;
        pendingTaxRoute -= fromRoute;
        totalTaxBurned += toBurn;
        totalTaxRouted += toRoute;

        Currency pegCurrency = Currency.wrap(peg);
        poolManager.burn(address(this), CurrencyLibrary.toId(pegCurrency), total);
        poolManager.take(pegCurrency, address(this), total);

        if (toBurn > 0) IBurnable(peg).burn(toBurn);
        if (toRoute > 0) IERC20(peg).safeTransfer(dest, toRoute);
        emit DeferredTaxSettled(toBurn, toRoute);
        return abi.encode(toBurn, toRoute);
    }

    /// @notice Everything a keeper or monitor needs about deferred tax in one call.
    /// @return pendingBurn   Tax owed to the burn, not yet redeemed.
    /// @return pendingRoute  Tax owed to the fee recipient, not yet redeemed.
    /// @return claimsHeld    ERC-6909 PEG claims the hook holds on the PoolManager.
    ///                       Must be >= pendingBurn + pendingRoute; less means a deficit.
    /// @return settleableNow How much `settleDeferredTax` could redeem right now.
    function deferredTaxStatus()
        external
        view
        returns (uint256 pendingBurn, uint256 pendingRoute, uint256 claimsHeld, uint256 settleableNow)
    {
        pendingBurn = pendingTaxBurn;
        pendingRoute = pendingTaxRoute;
        claimsHeld = poolManager.balanceOf(address(this), CurrencyLibrary.toId(Currency.wrap(peg)));
        uint256 reserves = IERC20(peg).balanceOf(address(poolManager));
        uint256 owed = pendingBurn + pendingRoute;
        settleableNow = owed < reserves ? owed : reserves;
    }

    // ------------------------------------------------------------------
    // Fire Tax ratchet
    // ------------------------------------------------------------------

    /// @notice Advance the tax ratchet without swapping. Permissionless; keepers call it so
    ///         a recovery window opens as soon as the TWAP allows rather than at the next
    ///         trade. It can raise the rate, open a window, or complete one — never skip one.
    function pokeTaxRate() external returns (uint256) {
        if (!bound) revert UnknownPool();
        return _syncTaxRate(_taxPrice(lastTick));
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

    function setFeeRecipient(
        address newFeeRecipient
    ) external onlyTrustees {
        emit FeeRecipientSet(feeRecipient, newFeeRecipient);
        feeRecipient = newFeeRecipient;
    }

    /// @notice Point the tax at a TWAP source, or pass zero to fall back to spot.
    function setTaxOracle(
        address newTaxOracle
    ) external onlyTrustees {
        emit TaxOracleSet(address(taxOracle), newTaxOracle);
        taxOracle = IOracle(newTaxOracle);
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

    /// @notice Update a single tier's target rate. Bounded by the immutable `MAX_TAX_BPS`.
    function setTaxTiersRate(
        uint256 index,
        uint256 newRate
    ) external onlyTrustees {
        if (index >= taxTiersRates.length) revert TierIndexOutOfRange();
        if (newRate > MAX_TAX_BPS) revert TaxRateTooHigh();
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

    /// @notice Compute the 1e18-scaled PEG/WETH price at a given tick.
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

    /// @notice The price (1e18-scaled WETH per PEG) the sell tax is assessed against right
    ///         now: the oracle TWAP when available, otherwise the pool's resting spot price.
    function currentTaxPrice() public view returns (uint256) {
        return _taxPrice(lastTick);
    }

    /// @notice The sell-tax rate (bps) a PEG sell would pay right now, ignoring the
    ///         `autoCalculateTax` switch and sender exclusions. Includes any ratchet step
    ///         the next swap would apply.
    function currentTaxRate() external view returns (uint256 rate) {
        (rate,,) = _nextTaxState(_taxRateForPrice(currentTaxPrice()));
    }

    /// @notice The rate the schedule points at for the current tax price, before the
    ///         ratchet. Above `currentTaxRate` never; below it while a recovery is pending.
    function targetTaxRate() external view returns (uint256) {
        return _taxRateForPrice(currentTaxPrice());
    }

    /// @notice The pending decrease, if any, as the next swap would see it.
    /// @return toRate  The rate `taxRate` will fall to. Zero when none is pending.
    /// @return readyAt Timestamp from which that decrease can take effect.
    function pendingTaxDecrease() external view returns (uint256 toRate, uint256 readyAt) {
        (, uint16 candidate, uint40 startedAt) = _nextTaxState(_taxRateForPrice(currentTaxPrice()));
        if (startedAt == 0) return (0, 0);
        return (candidate, uint256(startedAt) + TAX_RECOVERY_PERIOD);
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    /// @dev Apply `_nextTaxState` for the schedule's target at `price` and persist it.
    function _syncTaxRate(
        uint256 price
    ) internal returns (uint256) {
        (uint16 rate, uint16 candidate, uint40 startedAt) = _nextTaxState(_taxRateForPrice(price));

        uint16 previous = taxRate;
        if (rate != previous) {
            taxRate = rate;
            emit TaxRateChanged(previous, rate);
        }
        if (startedAt != taxRecoveryStartedAt || candidate != taxRecoveryRate) {
            if (startedAt != 0 && startedAt != taxRecoveryStartedAt) {
                emit TaxRecoveryStarted(rate, candidate, uint256(startedAt) + TAX_RECOVERY_PERIOD);
            }
            taxRecoveryStartedAt = startedAt;
            taxRecoveryRate = candidate;
        }
        return rate;
    }

    /// @dev The Fire Tax ratchet. Given the schedule's `target` rate now, returns the rate
    ///      to charge and the recovery bookkeeping.
    ///
    ///        - target >= rate: charge the target at once and cancel any pending decrease.
    ///        - target <  rate: a recovery window runs. The candidate is the HIGHEST target
    ///          seen during the window, so a rate is only ever adopted after standing for
    ///          the full period. When the window closes the candidate becomes the rate; if
    ///          the target is lower still, a fresh window opens for it.
    ///
    ///      Targets are sampled when the hook runs (swaps and `pokeTaxRate`), so the window
    ///      opens at the first observation of a lower target, never earlier.
    function _nextTaxState(
        uint256 target
    ) internal view returns (uint16 rate, uint16 candidate, uint40 startedAt) {
        rate = taxRate;
        // Tier rates are capped by the setter; clamp anyway so no path can exceed the max.
        uint16 t = uint16(target > MAX_TAX_BPS ? MAX_TAX_BPS : target);

        if (t >= rate) return (t, 0, 0);

        candidate = taxRecoveryRate;
        startedAt = taxRecoveryStartedAt;
        if (startedAt == 0) return (rate, t, uint40(block.timestamp));

        if (t > candidate) candidate = t;
        if (block.timestamp - startedAt < TAX_RECOVERY_PERIOD) return (rate, candidate, startedAt);

        rate = candidate;
        if (t < rate) return (rate, t, uint40(block.timestamp));
        return (rate, 0, 0);
    }

    /// @dev TWAP from `taxOracle` when it has one; the spot price at `spotTick` otherwise.
    ///      The fallback keeps sells working — and taxed — if the oracle is unset, has not
    ///      finished its first epoch, or fails.
    function _taxPrice(
        int24 spotTick
    ) internal view returns (uint256) {
        IOracle oracle = taxOracle;
        if (address(oracle) != address(0)) {
            try oracle.consult(peg, 1e18) returns (uint144 twap) {
                if (twap > 0) return twap;
            } catch {}
        }
        return _priceFromTick(spotTick);
    }

    /// @dev True when a swap in direction `zeroForOne` by `sender` is a PEG sell that the
    ///      tax applies to.
    function _isTaxedSell(
        address sender,
        bool zeroForOne
    ) internal view returns (bool) {
        return autoCalculateTax && pegIsCurrency0 == zeroForOne && !excludedAddresses[sender];
    }

    /// @dev Claim `taxAmount` PEG from the PoolManager and burn / route it. The caller
    ///      must report the same amount to the PoolManager as a positive hook delta.
    ///
    ///      Hook callbacks run BEFORE the router settles the swapper's input, so an
    ///      immediate `take` is paid out of PEG the PoolManager already holds. Normally
    ///      that is ample. When it is not — the pool is almost entirely WETH because price
    ///      sits above its liquidity range — a `take` would revert and block exactly the
    ///      sells that pull price back to peg. In that case the tax is taken as ERC-6909
    ///      claims instead (no token transfer) and redeemed later via `settleDeferredTax`.
    ///      The burn-vs-route decision is fixed here, at the swap's price, either way.
    function _collectTax(
        uint256 taxAmount,
        uint256 price
    ) internal {
        Currency pegCurrency = Currency.wrap(peg);
        bool toBurn = price < burnThreshold || feeRecipient == address(0);
        totalTaxAssessed += taxAmount;

        if (IERC20(peg).balanceOf(address(poolManager)) < taxAmount) {
            if (toBurn) pendingTaxBurn += taxAmount;
            else pendingTaxRoute += taxAmount;
            poolManager.mint(address(this), CurrencyLibrary.toId(pegCurrency), taxAmount);
            emit TaxDeferred(taxAmount, toBurn, price);
            return;
        }

        poolManager.take(pegCurrency, address(this), taxAmount);
        if (toBurn) {
            // Below-threshold burn is the load-bearing deflationary lever during
            // contraction. An unset Treasury also burns: Trustees should set one before
            // flipping autoCalculateTax on.
            totalTaxBurned += taxAmount;
            IBurnable(peg).burn(taxAmount);
            emit TaxBurned(taxAmount, price);
        } else {
            totalTaxRouted += taxAmount;
            IERC20(peg).safeTransfer(feeRecipient, taxAmount);
            emit TaxRouted(feeRecipient, taxAmount, price);
        }
    }

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
    }

    /// @dev Map current tick to a fee tier based on signed deviation from `pegTick`.
    function _feeForTick(
        int24 currentTick
    ) internal view returns (uint24) {
        int24 delta = pegIsCurrency0 ? currentTick - pegTick : pegTick - currentTick;
        if (delta >= bandTicks) return expansionFee;
        if (delta > -bandTicks) return baseFee;
        if (delta > -2 * bandTicks) return contractionFee;
        return deepContractionFee;
    }

    /// @dev Convert a tick to a 1e18-scaled PEG/WETH price. Uses two FullMath.mulDiv
    ///      steps to avoid a 512-bit-product overflow at high-tick magnitudes.
    function _priceFromTick(
        int24 tick
    ) internal view returns (uint256 price) {
        uint160 sqrtP = TickMath.getSqrtPriceAtTick(tick);
        if (pegIsCurrency0) {
            // PEG is currency0 → price (1e18 scaled) = sqrtP^2 / 2^192 * 1e18.
            // Two mulDiv passes: first divides by 2^96, second multiplies by 1e18/2^96.
            uint256 stage = FullMath.mulDiv(uint256(sqrtP), uint256(sqrtP), 1 << 96);
            price = FullMath.mulDiv(stage, 1e18, 1 << 96);
        } else {
            // PEG is currency1 → price = 2^192 / sqrtP^2 * 1e18.
            uint256 stage = FullMath.mulDiv(1 << 96, 1e18, uint256(sqrtP));
            price = FullMath.mulDiv(stage, 1 << 96, uint256(sqrtP));
        }
    }

    /// @dev Walk tier table high → low; the first threshold `price` reaches sets the rate. Returns 0 if no tier matches
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
