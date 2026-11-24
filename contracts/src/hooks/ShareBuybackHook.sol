// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
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

import {BaseV4Hook} from "./base/BaseV4Hook.sol";
import {IPriceSource} from "../interfaces/IPriceSource.sol";
import {Trustees} from "../governance/Trustees.sol";

/// @dev The Fire Tax rate, as published by the peg token's hook.
interface IFireTaxSource {
    function pokeTaxRate() external returns (uint256);
}

interface IBurnableToken {
    function burn(
        uint256 amount
    ) external;
}

/// @notice The low-14-bit address pattern ShareBuybackHook must be deployed at.
library ShareBuybackHookPermissions {
    uint160 internal constant FLAGS = uint160(
        Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
    );
}

/**
 * @title ShareBuybackHook
 * @notice V4 hook for the SHARE/QUOTE pool. Implements one policy, end to end:
 *
 *             SHARE sell tax  →  QUOTE  →  PEG  →  100% burn
 *
 *         1. **Collect.** A sell of SHARE pays the Fire Tax out of its QUOTE proceeds. The
 *            rate is read from the peg token's hook, so both tokens share one ratchet
 *            (immediate increases, seven-hour decreases) and one ceiling. It is clamped
 *            here to `MAX_TAX_BPS` (12%) as well, so no upstream change can exceed it.
 *            Buys are never taxed. There is no exemption list.
 *
 *         2. **Hold.** The tax is taken as ERC-6909 QUOTE claims on the PoolManager and
 *            recorded in `pendingQuote`. Nothing is converted inside a user's swap, so a
 *            buyback that cannot run can never make a sell revert.
 *
 *         3. **Convert and burn.** `executeBuyback()` is permissionless. It swaps pending
 *            QUOTE for PEG in the peg pool and burns every PEG unit received. The hook has
 *            no other way to move value: no Treasury share, no POL share, no reserve, no
 *            sweep, no recipient to configure.
 *
 * @dev    **Buyback safety.** A permissionless market buy is a sandwich target, so the swap
 *         is bounded by a price limit: it will not pay more than `maxPremiumTicks` above a
 *         TWAP of the peg pool measured over at least `twapWindow`. If spot is already past
 *         that limit the buyback spends nothing and the tax simply stays pending; if the
 *         limit is reached part-way, the remainder stays pending. The TWAP comes from this
 *         hook's own checkpoints of the peg pool's tick accumulator. It deliberately does
 *         not read the protocol Oracle, so the tax system stays independent of the peg
 *         token's mint gating.
 *
 *         **Accounting.** At all times:
 *             totalQuoteAssessed == totalQuoteConverted + pendingQuote
 *             ERC-6909 QUOTE claims held by this hook == pendingQuote
 *         and after any call the hook holds no SHARE, QUOTE or PEG tokens.
 *
 *         **Tax arithmetic.** Both swap modes charge rate `r` on the seller's gross QUOTE
 *         proceeds:
 *           - exact-input  (QUOTE is the unspecified token): assessed in `afterSwap` on the
 *             actual output, `tax = out * r`.
 *           - exact-output (QUOTE is the specified token): assessed in `beforeSwap`. The
 *             pool is asked for `W + tax` so the seller still receives exactly `W`, with
 *             `tax = W * r / (1 - r)`.
 */
contract ShareBuybackHook is BaseV4Hook, Trustees, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using SafeCast for uint256;

    /// @notice The permission bits this hook's deployed address must carry.
    uint160 public constant PERMISSION_FLAGS = ShareBuybackHookPermissions.FLAGS;

    uint256 internal constant BPS = 10_000;

    /// @notice Hard ceiling on the sell tax, whatever the rate source reports.
    uint256 public constant MAX_TAX_BPS = 1200;

    /// @notice Bounds for the Trustees-settable buyback guard.
    uint32 public constant MIN_TWAP_WINDOW = 10 minutes;
    uint32 public constant MAX_TWAP_WINDOW = 6 hours;
    int24 public constant MAX_PREMIUM_TICKS = 500; // ≈ 5%

    /// @notice A checkpoint older than this is discarded rather than averaged over.
    uint32 public constant MAX_CHECKPOINT_AGE = 24 hours;

    // ------------------------------------------------------------------
    // Immutable wiring — none of this can be redirected after deployment
    // ------------------------------------------------------------------

    /// @notice The taxed token (SQUARE / SHARE).
    address public immutable share;

    /// @notice The token bought and burned (LEVEL / PEG).
    address public immutable peg;

    /// @notice The asset the tax is collected in and the buyback is paid with (USDC / WETH).
    address public immutable quote;

    /// @notice Publishes the Fire Tax rate. In production this is the peg pool's hook.
    IFireTaxSource public immutable fireTax;

    /// @notice Tick accumulator of the peg pool, used for the buyback's TWAP price limit.
    IPriceSource public immutable pegPriceSource;

    /// @notice True if PEG sorts as currency0 in the peg pool.
    bool public immutable pegIsCurrency0;

    /// @dev The PEG/QUOTE pool the buyback trades in.
    PoolKey internal _pegPoolKey;

    // ------------------------------------------------------------------
    // Pool binding
    // ------------------------------------------------------------------

    PoolId public poolId;
    bool public bound;
    bool public shareIsCurrency0;

    // ------------------------------------------------------------------
    // Tax + accounting state
    // ------------------------------------------------------------------

    /// @notice Master switch. Off at deploy; Trustees enables it.
    bool public taxEnabled;

    /// @notice QUOTE collected and not yet converted. Backed 1:1 by PoolManager claims.
    uint256 public pendingQuote;

    uint256 public totalQuoteAssessed;
    uint256 public totalQuoteConverted;
    uint256 public totalPegBurned;

    // ------------------------------------------------------------------
    // Buyback guard
    // ------------------------------------------------------------------

    /// @notice Minimum span the buyback's TWAP must cover. Also the minimum gap between
    ///         buybacks, since each one starts a new span.
    uint32 public twapWindow = 30 minutes;

    /// @notice How far above the TWAP (in ticks, ≈ basis points) a buyback may pay.
    int24 public maxPremiumTicks = 100;

    int56 public checkpointCumulative;
    uint32 public checkpointTimestamp;

    // ------------------------------------------------------------------
    // Events / errors
    // ------------------------------------------------------------------

    event Bound(PoolId indexed poolId, bool shareIsCurrency0);
    event TaxEnabledSet(bool enabled);
    event BuybackGuardSet(uint32 twapWindow, int24 maxPremiumTicks);
    event TaxDeferred(uint256 quoteAmount, uint256 rateBps);
    event BuybackExecuted(uint256 quoteSpent, uint256 pegBurned, uint256 quoteStillPending);
    event BuybackSkipped(uint256 quotePending);

    error AlreadyBound();
    error UnknownPool();
    error WrongPoolTokens();
    error PegPoolMissingPeg();
    error IdenticalTokens();
    error GuardOutOfRange();

    constructor(
        IPoolManager _poolManager,
        address _share,
        address _peg,
        PoolKey memory pegPoolKey_,
        IFireTaxSource _fireTax,
        IPriceSource _pegPriceSource,
        address _initialTrustees
    ) BaseV4Hook(_poolManager) {
        address c0 = Currency.unwrap(pegPoolKey_.currency0);
        address c1 = Currency.unwrap(pegPoolKey_.currency1);
        if (c0 != _peg && c1 != _peg) revert PegPoolMissingPeg();
        address _quote = c0 == _peg ? c1 : c0;
        if (_share == _peg || _share == _quote) revert IdenticalTokens();

        share = _share;
        peg = _peg;
        quote = _quote;
        pegIsCurrency0 = c0 == _peg;
        _pegPoolKey = pegPoolKey_;
        fireTax = _fireTax;
        pegPriceSource = _pegPriceSource;

        _transferTrustees(_initialTrustees); // reverts on zero address
        _transferOwnership(_initialTrustees);
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
            beforeSwap: true, // exact-output sell tax (QUOTE is the specified token)
            afterSwap: true, // exact-input sell tax (QUOTE is the unspecified token)
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    function afterInitialize(
        address, /* sender */
        PoolKey calldata key,
        uint160, /* sqrtPriceX96 */
        int24 /* tick */
    ) external override onlyPoolManager returns (bytes4) {
        if (bound) revert AlreadyBound();
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        if (!((c0 == share && c1 == quote) || (c0 == quote && c1 == share))) revert WrongPoolTokens();

        shareIsCurrency0 = c0 == share;
        poolId = key.toId();
        bound = true;

        emit Bound(poolId, shareIsCurrency0);
        return IHooks.afterInitialize.selector;
    }

    function beforeSwap(
        address, /* sender */
        PoolKey calldata key,
        SwapParams calldata params,
        bytes calldata /* hookData */
    ) external override onlyPoolManager returns (bytes4, BeforeSwapDelta, uint24) {
        _requireOurPool(key);

        // Exact-output SHARE sells only: `amountSpecified` is the QUOTE the seller wants.
        if (params.amountSpecified <= 0 || !_isTaxedSell(params.zeroForOne)) {
            return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        uint256 rate = _fireTaxRate();
        if (rate == 0) return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);

        // Rounded up so the effective rate on gross proceeds never falls below `rate`.
        uint256 taxAmount = FullMath.mulDivRoundingUp(uint256(params.amountSpecified), rate, BPS - rate);
        _defer(taxAmount, rate);

        // Positive specified delta on an exact-output swap: the pool pays out `taxAmount`
        // more QUOTE, which goes to the hook, and the seller still receives the amount
        // they specified.
        return (IHooks.beforeSwap.selector, toBeforeSwapDelta(taxAmount.toInt128(), int128(0)), 0);
    }

    function afterSwap(
        address, /* sender */
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata /* hookData */
    ) external override onlyPoolManager returns (bytes4, int128) {
        _requireOurPool(key);

        // Exact-input SHARE sells only: QUOTE is the unspecified token.
        if (params.amountSpecified >= 0 || !_isTaxedSell(params.zeroForOne)) {
            return (IHooks.afterSwap.selector, 0);
        }

        // The pool's QUOTE leg is positive from the swapper's side: they are owed it.
        int128 quoteDelta = shareIsCurrency0 ? delta.amount1() : delta.amount0();
        if (quoteDelta <= 0) return (IHooks.afterSwap.selector, 0);

        uint256 rate = _fireTaxRate();
        uint256 taxAmount = uint256(uint128(quoteDelta)) * rate / BPS;
        if (taxAmount == 0) return (IHooks.afterSwap.selector, 0);

        _defer(taxAmount, rate);

        // Positive unspecified delta: the hook keeps `taxAmount` of the seller's proceeds.
        return (IHooks.afterSwap.selector, taxAmount.toInt128());
    }

    // ------------------------------------------------------------------
    // Convert and burn
    // ------------------------------------------------------------------

    /// @notice Swap pending QUOTE for PEG and burn all of it. Permissionless.
    ///
    ///         Never reverts for market reasons. It returns (0, 0) and leaves the tax
    ///         pending when there is nothing to convert, when the TWAP span is still too
    ///         short, or when the peg pool's spot price is already above the price limit.
    ///         It converts partially when the limit is reached part-way. It is therefore
    ///         safe to call on any schedule, by anyone.
    /// @return quoteSpent QUOTE converted by this call.
    /// @return pegBurned  PEG burned by this call.
    function executeBuyback() external returns (uint256 quoteSpent, uint256 pegBurned) {
        if (pendingQuote == 0) return (0, 0);

        (int56 cumulative, uint32 timestamp) = pegPriceSource.getCurrentTickCumulative();
        uint32 elapsed = timestamp - checkpointTimestamp;

        // No usable span yet: start one and wait.
        if (checkpointTimestamp == 0 || elapsed > MAX_CHECKPOINT_AGE) {
            _checkpoint(cumulative, timestamp);
            return (0, 0);
        }
        if (elapsed < twapWindow) return (0, 0);

        int24 twapTick = int24((cumulative - checkpointCumulative) / int56(uint56(elapsed)));
        _checkpoint(cumulative, timestamp);

        (quoteSpent, pegBurned) = abi.decode(poolManager.unlock(abi.encode(twapTick)), (uint256, uint256));
        if (quoteSpent == 0) emit BuybackSkipped(pendingQuote);
        else emit BuybackExecuted(quoteSpent, pegBurned, pendingQuote);
    }

    /// @inheritdoc IUnlockCallback
    function unlockCallback(
        bytes calldata data
    ) external onlyPoolManager returns (bytes memory) {
        int24 twapTick = abi.decode(data, (int24));
        PoolKey memory pegKey = _pegPoolKey;

        // Buying PEG moves the pool price toward more QUOTE per PEG. In pool terms that is
        // upward when PEG is currency0 and downward when it is currency1.
        bool zeroForOne = !pegIsCurrency0;
        int24 limitTick = pegIsCurrency0 ? twapTick + maxPremiumTicks : twapTick - maxPremiumTicks;
        if (limitTick > TickMath.MAX_TICK - 1) limitTick = TickMath.MAX_TICK - 1;
        if (limitTick < TickMath.MIN_TICK + 1) limitTick = TickMath.MIN_TICK + 1;
        uint160 limit = TickMath.getSqrtPriceAtTick(limitTick);

        // Spot already past the limit: someone has pushed PEG up. Do not buy into it.
        // slither-disable-next-line unused-return — only the price is needed from slot0.
        (uint160 spot,,,) = poolManager.getSlot0(pegKey.toId());
        if (spot == 0 || (zeroForOne ? spot <= limit : spot >= limit)) return abi.encode(uint256(0), uint256(0));

        BalanceDelta delta = poolManager.swap(
            pegKey,
            SwapParams({zeroForOne: zeroForOne, amountSpecified: -pendingQuote.toInt256(), sqrtPriceLimitX96: limit}),
            ""
        );
        int128 quoteDelta = pegIsCurrency0 ? delta.amount1() : delta.amount0();
        int128 pegDelta = pegIsCurrency0 ? delta.amount0() : delta.amount1();
        if (quoteDelta >= 0 || pegDelta <= 0) return abi.encode(uint256(0), uint256(0));

        uint256 quoteSpent = uint256(uint128(-quoteDelta));
        uint256 pegOut = uint256(uint128(pegDelta));

        pendingQuote -= quoteSpent;
        totalQuoteConverted += quoteSpent;
        totalPegBurned += pegOut;

        // Pay the QUOTE leg with the claims that have backed it since collection, take the
        // PEG leg as tokens, and destroy it.
        poolManager.burn(address(this), CurrencyLibrary.toId(Currency.wrap(quote)), quoteSpent);
        poolManager.take(Currency.wrap(peg), address(this), pegOut);
        IBurnableToken(peg).burn(pegOut);

        return abi.encode(quoteSpent, pegOut);
    }

    /// @notice Everything a keeper or monitor needs in one call.
    /// @return pending     QUOTE collected and not yet converted.
    /// @return claimsHeld  ERC-6909 QUOTE claims held. Must equal `pending`.
    /// @return readyAt     Earliest timestamp `executeBuyback` can convert. Zero when a
    ///                     checkpoint still has to be taken first.
    function buybackStatus() external view returns (uint256 pending, uint256 claimsHeld, uint256 readyAt) {
        pending = pendingQuote;
        claimsHeld = poolManager.balanceOf(address(this), CurrencyLibrary.toId(Currency.wrap(quote)));
        if (checkpointTimestamp != 0 && block.timestamp - checkpointTimestamp <= MAX_CHECKPOINT_AGE) {
            readyAt = uint256(checkpointTimestamp) + twapWindow;
        }
    }

    function pegPoolKey() external view returns (PoolKey memory) {
        return _pegPoolKey;
    }

    // ------------------------------------------------------------------
    // Trustees — the whole admin surface
    // ------------------------------------------------------------------

    function setTaxEnabled(
        bool enabled
    ) external onlyTrustees {
        taxEnabled = enabled;
        emit TaxEnabledSet(enabled);
    }

    /// @notice Tune the buyback's price guard, within fixed bounds. Cannot disable it.
    function setBuybackGuard(
        uint32 newTwapWindow,
        int24 newMaxPremiumTicks
    ) external onlyTrustees {
        if (newTwapWindow < MIN_TWAP_WINDOW || newTwapWindow > MAX_TWAP_WINDOW) revert GuardOutOfRange();
        if (newMaxPremiumTicks < 0 || newMaxPremiumTicks > MAX_PREMIUM_TICKS) revert GuardOutOfRange();
        twapWindow = newTwapWindow;
        maxPremiumTicks = newMaxPremiumTicks;
        emit BuybackGuardSet(newTwapWindow, newMaxPremiumTicks);
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    function _requireOurPool(
        PoolKey calldata key
    ) internal view {
        if (!bound || PoolId.unwrap(key.toId()) != PoolId.unwrap(poolId)) revert UnknownPool();
    }

    function _isTaxedSell(
        bool zeroForOne
    ) internal view returns (bool) {
        return taxEnabled && shareIsCurrency0 == zeroForOne;
    }

    /// @dev The Fire Tax rate, synced at its source and clamped to this hook's own ceiling.
    ///      If the source fails, charge the ceiling: a broken dependency must neither block
    ///      the sell nor waive the tax.
    function _fireTaxRate() internal returns (uint256) {
        try fireTax.pokeTaxRate() returns (uint256 rate) {
            return rate > MAX_TAX_BPS ? MAX_TAX_BPS : rate;
        } catch {
            return MAX_TAX_BPS;
        }
    }

    /// @dev Take `taxAmount` QUOTE as PoolManager claims and record it. No token moves, so
    ///      this cannot fail for lack of reserves. The caller must report the same amount
    ///      to the PoolManager as a positive hook delta.
    function _defer(
        uint256 taxAmount,
        uint256 rate
    ) internal {
        pendingQuote += taxAmount;
        totalQuoteAssessed += taxAmount;

        // Start the TWAP span now so the buyback is ready one window from this sell.
        if (checkpointTimestamp == 0 || block.timestamp - checkpointTimestamp > MAX_CHECKPOINT_AGE) {
            try pegPriceSource.getCurrentTickCumulative() returns (int56 cumulative, uint32 timestamp) {
                _checkpoint(cumulative, timestamp);
            } catch {}
        }

        poolManager.mint(address(this), CurrencyLibrary.toId(Currency.wrap(quote)), taxAmount);
        emit TaxDeferred(taxAmount, rate);
    }

    function _checkpoint(
        int56 cumulative,
        uint32 timestamp
    ) internal {
        checkpointCumulative = cumulative;
        checkpointTimestamp = timestamp;
    }
}
