// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";

import {PegDefenseHook} from "../../src/hooks/PegDefenseHook.sol";
import {BaseV4Hook} from "../../src/hooks/base/BaseV4Hook.sol";
import {OldMoney} from "../../src/tokens/OldMoney.sol";
import {Trustees} from "../../src/governance/Trustees.sol";

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal pool manager stub: implements only `extsload(bytes32)` so the hook can
///         read Slot0 via V4's StateLibrary, plus a `take` stub for Sprint 4b tax tests.
///         `setTick` packs the tick into the slot0 layout.
contract MockPoolManager {
    bytes32 public slot0Data;

    // Sprint 4b — when the hook calls poolManager.take(currency, to, amount) in beforeSwap
    // to pull a tax slice into its balance, we simulate it by transferring from the mock's
    // own balance. Tests must pre-fund the mock with MONEY before exercising tax paths.
    address public lastTakeRecipient;
    uint256 public lastTakeAmount;
    address public lastTakeCurrency;
    uint256 public takeCallCount;

    function setTick(
        int24 tick
    ) external {
        // Slot0 layout: bottom 160 bits = sqrtPriceX96, next 24 = tick.
        slot0Data = bytes32(uint256(uint24(tick)) << 160);
    }

    function extsload(
        bytes32
    ) external view returns (bytes32) {
        return slot0Data;
    }

    /// @notice IPoolManager.take stub. The mock holds the currency balance; calling this
    ///         transfers `amount` out to `to`. Reverts if mock isn't pre-funded.
    function take(
        Currency currency,
        address to,
        uint256 amount
    ) external {
        lastTakeCurrency = Currency.unwrap(currency);
        lastTakeRecipient = to;
        lastTakeAmount = amount;
        takeCallCount += 1;
        IERC20(Currency.unwrap(currency)).transfer(to, amount);
    }
}

contract PegDefenseHookTest is BaseTest {
    using PoolIdLibrary for PoolKey;

    PegDefenseHook internal hook;
    MockPoolManager internal pm;
    OldMoney internal money;
    address internal weth = makeAddr("weth");
    PoolKey internal poolKey;

    address internal hookAddr;

    function setUp() public override {
        super.setUp();
        vm.label(weth, "weth");

        vm.warp(1_700_000_000);

        pm = new MockPoolManager();

        vm.prank(owner);
        money = new OldMoney();

        // Compute the only address with the right permission bits we need:
        // AFTER_INITIALIZE | BEFORE_SWAP.
        hookAddr = address(
            uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG)
        );

        deployCodeTo(
            "PegDefenseHook.sol:PegDefenseHook",
            abi.encode(IPoolManager(address(pm)), address(money), address(this)),
            hookAddr
        );
        hook = PegDefenseHook(hookAddr);

        // Sort the two tokens into V4 currency order.
        (Currency c0, Currency c1) = address(money) < weth
            ? (Currency.wrap(address(money)), Currency.wrap(weth))
            : (Currency.wrap(weth), Currency.wrap(address(money)));

        poolKey = PoolKey({
            currency0: c0, currency1: c1, fee: LPFeeLibrary.DYNAMIC_FEE_FLAG, tickSpacing: 60, hooks: IHooks(hookAddr)
        });

        // The hook's Trustees defaulted to the test contract (msg.sender during deployCodeTo).
        // Rotate to the dedicated `trustees` actor for clearer test semantics.
        hook.transferTrustees(trustees);
    }

    // ---------------------------------------------------------------------
    // Constructor + hook permissions
    // ---------------------------------------------------------------------

    function test_Constructor_StoresImmutables() public view {
        assertEq(address(hook.poolManager()), address(pm));
        assertEq(hook.money(), address(money));
    }

    function test_HookPermissions_AfterInitBeforeSwapAndReturnsDelta() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.afterInitialize);
        assertTrue(p.beforeSwap);
        assertTrue(p.beforeSwapReturnDelta, "Sprint 4b: returnDelta required for tax slice");
        assertFalse(p.beforeInitialize);
        assertFalse(p.afterSwap);
        assertFalse(p.beforeAddLiquidity);
        assertFalse(p.afterAddLiquidity);
        assertFalse(p.beforeRemoveLiquidity);
        assertFalse(p.afterRemoveLiquidity);
        assertFalse(p.beforeDonate);
        assertFalse(p.afterDonate);
        assertFalse(p.afterSwapReturnDelta);
        assertFalse(p.afterAddLiquidityReturnDelta);
        assertFalse(p.afterRemoveLiquidityReturnDelta);
    }

    function test_DefaultRevertingHooks_AreUncallable() public {
        vm.prank(address(pm));
        vm.expectRevert(BaseV4Hook.HookNotImplemented.selector);
        hook.beforeInitialize(address(0), poolKey, 0);

        vm.prank(address(pm));
        vm.expectRevert(BaseV4Hook.HookNotImplemented.selector);
        hook.beforeDonate(address(0), poolKey, 0, 0, "");
    }

    // ---------------------------------------------------------------------
    // afterInitialize
    // ---------------------------------------------------------------------

    function test_AfterInitialize_OnlyPoolManager() public {
        vm.prank(stranger);
        vm.expectRevert(BaseV4Hook.NotPoolManager.selector);
        hook.afterInitialize(address(0), poolKey, 0, 0);
    }

    function test_AfterInitialize_RecordsState() public {
        vm.prank(address(pm));
        hook.afterInitialize(address(0), poolKey, 0, 123);

        assertTrue(hook.bound());
        assertEq(hook.lastTick(), 123);
        assertEq(hook.lastObservationTimestamp(), uint32(block.timestamp));
        assertEq(hook.tickCumulative(), 0);
        bytes32 expectedId = PoolId.unwrap(poolKey.toId());
        assertEq(PoolId.unwrap(hook.poolId()), expectedId);
    }

    function test_AfterInitialize_DetectsMoneyOrientation() public {
        vm.prank(address(pm));
        hook.afterInitialize(address(0), poolKey, 0, 0);
        // MONEY is currency0 iff its address is the lower of the two.
        bool expectedIsCurrency0 = address(money) < weth;
        assertEq(hook.moneyIsCurrency0(), expectedIsCurrency0);
    }

    function test_AfterInitialize_OneShot() public {
        vm.prank(address(pm));
        hook.afterInitialize(address(0), poolKey, 0, 0);

        vm.prank(address(pm));
        vm.expectRevert(PegDefenseHook.AlreadyBound.selector);
        hook.afterInitialize(address(0), poolKey, 0, 0);
    }

    function test_AfterInitialize_RejectsPoolMissingMoney() public {
        address otherA = makeAddr("otherA");
        address otherB = makeAddr("otherB");
        (Currency c0, Currency c1) = otherA < otherB
            ? (Currency.wrap(otherA), Currency.wrap(otherB))
            : (Currency.wrap(otherB), Currency.wrap(otherA));
        PoolKey memory badKey = PoolKey({
            currency0: c0, currency1: c1, fee: LPFeeLibrary.DYNAMIC_FEE_FLAG, tickSpacing: 60, hooks: IHooks(hookAddr)
        });

        vm.prank(address(pm));
        vm.expectRevert(PegDefenseHook.PoolMissingMoney.selector);
        hook.afterInitialize(address(0), badKey, 0, 0);
    }

    // ---------------------------------------------------------------------
    // beforeSwap — observation + fee
    // ---------------------------------------------------------------------

    function test_BeforeSwap_OnlyPoolManager() public {
        _bind(0);
        vm.prank(stranger);
        vm.expectRevert(BaseV4Hook.NotPoolManager.selector);
        hook.beforeSwap(address(0), poolKey, _emptySwap(), "");
    }

    function test_BeforeSwap_RequiresBoundPool() public {
        // Not bound yet -> revert.
        vm.prank(address(pm));
        vm.expectRevert(PegDefenseHook.UnknownPool.selector);
        hook.beforeSwap(address(0), poolKey, _emptySwap(), "");
    }

    function test_BeforeSwap_AccumulatesObservation() public {
        _bind(0); // last tick = 0, lastObsTs = block.timestamp

        // Advance 1000 seconds at constant tick 0 — cumulative stays 0.
        vm.warp(block.timestamp + 1000);
        pm.setTick(0);
        vm.prank(address(pm));
        hook.beforeSwap(address(0), poolKey, _emptySwap(), "");
        assertEq(hook.tickCumulative(), 0);

        // Now the pool's tick is 100 (simulating post-swap state). Advance 500 seconds.
        vm.warp(block.timestamp + 500);
        pm.setTick(100);
        vm.prank(address(pm));
        hook.beforeSwap(address(0), poolKey, _emptySwap(), "");
        // Between the two beforeSwap calls, lastTick was still 0 (set in first call),
        // so cumulative gained 0 * 500 = 0.
        assertEq(hook.tickCumulative(), 0);
        assertEq(hook.lastTick(), 100);

        // Advance another 500 at tick 100 -> cumulative gains 100*500 = 50_000.
        vm.warp(block.timestamp + 500);
        pm.setTick(100);
        vm.prank(address(pm));
        hook.beforeSwap(address(0), poolKey, _emptySwap(), "");
        assertEq(hook.tickCumulative(), 50_000);
    }

    function test_BeforeSwap_ReturnsBaseFeeNearPeg() public {
        _bind(0);
        pm.setTick(0); // exactly at peg
        (, BeforeSwapDelta delta, uint24 feeOverride) = _beforeSwapCall();

        assertEq(BeforeSwapDelta.unwrap(delta), 0);
        // baseFee = 3000, ORed with OVERRIDE_FEE_FLAG.
        assertEq(feeOverride, uint24(3000) | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function test_BeforeSwap_ReturnsExpansionFeeAbovePeg() public {
        _bind(0);
        // 200 ticks above peg, MONEY is whichever side is currency0/1.
        // If money is currency0, currentTick > pegTick == "MONEY appreciating" -> expansion.
        // If money is currency1, we need currentTick LESS than peg to be expansion. Flip sign.
        int24 t = hook.moneyIsCurrency0() ? int24(200) : int24(-200);
        pm.setTick(t);

        (,, uint24 feeOverride) = _beforeSwapCall();
        assertEq(feeOverride, uint24(1000) | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function test_BeforeSwap_ReturnsContractionFeeBelowPeg() public {
        _bind(0);
        int24 t = hook.moneyIsCurrency0() ? int24(-150) : int24(150);
        pm.setTick(t);

        (,, uint24 feeOverride) = _beforeSwapCall();
        assertEq(feeOverride, uint24(10_000) | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function test_BeforeSwap_ReturnsDeepContractionFeeFarBelowPeg() public {
        _bind(0);
        int24 t = hook.moneyIsCurrency0() ? int24(-500) : int24(500);
        pm.setTick(t);

        (,, uint24 feeOverride) = _beforeSwapCall();
        assertEq(feeOverride, uint24(30_000) | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    // ---------------------------------------------------------------------
    // IPriceSource — getCurrentTickCumulative
    // ---------------------------------------------------------------------

    function test_GetCurrentTickCumulative_ZeroBeforeBind() public view {
        (int56 cum, uint32 ts) = hook.getCurrentTickCumulative();
        assertEq(cum, 0);
        assertEq(ts, uint32(block.timestamp));
    }

    function test_GetCurrentTickCumulative_ProjectsAtLastTick() public {
        _bind(50); // tick=50 at bind
        // No swaps yet. After 600 seconds, projection = 50 * 600 = 30_000.
        vm.warp(block.timestamp + 600);

        (int56 cum, uint32 ts) = hook.getCurrentTickCumulative();
        assertEq(cum, 30_000);
        assertEq(ts, uint32(block.timestamp));
    }

    // ---------------------------------------------------------------------
    // Trustees governance
    // ---------------------------------------------------------------------

    function test_SetPegTick_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        hook.setPegTick(123);
    }

    function test_SetPegTick_Updates() public {
        vm.prank(trustees);
        hook.setPegTick(50);
        assertEq(hook.pegTick(), 50);
    }

    function test_SetBandTicks_RejectsZero() public {
        vm.prank(trustees);
        vm.expectRevert(PegDefenseHook.BandTicksMustBePositive.selector);
        hook.setBandTicks(0);

        vm.prank(trustees);
        vm.expectRevert(PegDefenseHook.BandTicksMustBePositive.selector);
        hook.setBandTicks(-5);
    }

    function test_SetBandTicks_Updates() public {
        vm.prank(trustees);
        hook.setBandTicks(50);
        assertEq(hook.bandTicks(), 50);
    }

    function test_SetFees_RejectsTooHigh() public {
        vm.prank(trustees);
        vm.expectRevert(PegDefenseHook.FeeTooHigh.selector);
        hook.setFees(1, 2, 3, LPFeeLibrary.MAX_LP_FEE + 1);
    }

    function test_SetFees_UpdatesAllTiers() public {
        vm.prank(trustees);
        hook.setFees(500, 2000, 8000, 20_000);
        assertEq(hook.expansionFee(), 500);
        assertEq(hook.baseFee(), 2000);
        assertEq(hook.contractionFee(), 8000);
        assertEq(hook.deepContractionFee(), 20_000);
    }

    // ---------------------------------------------------------------------
    // Sprint 4b — tax surface defaults + tier table
    // ---------------------------------------------------------------------

    function test_Tax_Defaults() public view {
        assertFalse(hook.autoCalculateTax(), "tax off at deploy (Tomb default)");
        assertEq(hook.burnThreshold(), 1.1e18, "burnThreshold default 1.10e18 (Tomb)");
        assertEq(hook.treasury(), address(0), "treasury unset at deploy");
        assertEq(hook.getTaxTiersTwapsCount(), 14, "14 tiers (Tomb)");
        assertEq(hook.getTaxTiersRatesCount(), 14, "14 rates (Tomb)");
    }

    function test_Tax_TierTable_MatchesTomb() public view {
        // Exact values from Bomb.sol's taxTiersTwaps + taxTiersRates arrays.
        uint256[14] memory expectedTwaps = [
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
        uint256[14] memory expectedRates =
            [uint256(2000), 1900, 1800, 1700, 1600, 1500, 1500, 1500, 1500, 1400, 900, 400, 200, 100];

        for (uint256 i = 0; i < 14; ++i) {
            assertEq(hook.taxTiersTwaps(i), expectedTwaps[i], "twap mismatch");
            assertEq(hook.taxTiersRates(i), expectedRates[i], "rate mismatch");
        }
    }

    function test_Tax_RateLookup_TierBoundaries() public view {
        // Walk every tier boundary; verify the rate returned matches Tomb's lookup semantic
        // (first tier the price >= is the rate; walk high -> low).
        assertEq(hook.taxRateForPrice(0), 2000, "price 0 -> tier 0 -> 2000");
        assertEq(hook.taxRateForPrice(0.5e18 - 1), 2000, "just below 0.5 -> tier 0");
        assertEq(hook.taxRateForPrice(0.5e18), 1900, "exactly 0.5 -> tier 1");
        assertEq(hook.taxRateForPrice(0.99e18), 1500, "0.99 -> tier 6 (0.95)");
        assertEq(hook.taxRateForPrice(1.0e18), 1500, "at peg -> tier 7");
        assertEq(hook.taxRateForPrice(1.05e18), 1500, "1.05 -> tier 8");
        assertEq(hook.taxRateForPrice(1.1e18), 1400, "at burnThreshold -> tier 9");
        assertEq(hook.taxRateForPrice(1.1e18 - 1), 1500, "just below 1.10 -> tier 8");
        assertEq(hook.taxRateForPrice(1.5e18), 100, "at highest tier");
        assertEq(hook.taxRateForPrice(2.0e18), 100, "above highest -> highest rate");
    }

    function test_Tax_PriceFromTick_AtParity() public {
        _bind(0);
        uint256 p = hook.priceFromTick(0);
        // 1e18 ± 1 wei is acceptable due to sqrtP discretization at tick 0.
        assertApproxEqAbs(p, 1e18, 1, "price ~= 1e18 at tick 0");
    }

    // ---------------------------------------------------------------------
    // Sprint 4b — setter access control + validation
    // ---------------------------------------------------------------------

    function test_SetAutoCalculateTax_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        hook.setAutoCalculateTax(true);
    }

    function test_SetAutoCalculateTax_Updates() public {
        vm.prank(trustees);
        hook.setAutoCalculateTax(true);
        assertTrue(hook.autoCalculateTax());
        vm.prank(trustees);
        hook.setAutoCalculateTax(false);
        assertFalse(hook.autoCalculateTax());
    }

    function test_SetBurnThreshold_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        hook.setBurnThreshold(1.2e18);
    }

    function test_SetBurnThreshold_RejectsZero() public {
        vm.prank(trustees);
        vm.expectRevert(PegDefenseHook.BurnThresholdZero.selector);
        hook.setBurnThreshold(0);
    }

    function test_SetBurnThreshold_Updates() public {
        vm.prank(trustees);
        hook.setBurnThreshold(1.2e18);
        assertEq(hook.burnThreshold(), 1.2e18);
    }

    function test_SetTreasury_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        hook.setTreasury(makeAddr("t"));
    }

    function test_SetTreasury_Updates() public {
        address t = makeAddr("treasury");
        vm.prank(trustees);
        hook.setTreasury(t);
        assertEq(hook.treasury(), t);
    }

    function test_SetTaxTiersTwap_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        hook.setTaxTiersTwap(5, 0.91e18);
    }

    function test_SetTaxTiersTwap_RejectsOutOfRange() public {
        vm.prank(trustees);
        vm.expectRevert(PegDefenseHook.TierIndexOutOfRange.selector);
        hook.setTaxTiersTwap(14, 2e18);
    }

    function test_SetTaxTiersTwap_RejectsNonMonotonicDown() public {
        // Setting tier 5 (currently 0.90) to a value <= tier 4 (0.80) breaks monotonicity.
        vm.prank(trustees);
        vm.expectRevert(PegDefenseHook.NonMonotonicTier.selector);
        hook.setTaxTiersTwap(5, 0.8e18);
    }

    function test_SetTaxTiersTwap_RejectsNonMonotonicUp() public {
        // Setting tier 5 to a value >= tier 6 (0.95) breaks monotonicity.
        vm.prank(trustees);
        vm.expectRevert(PegDefenseHook.NonMonotonicTier.selector);
        hook.setTaxTiersTwap(5, 0.95e18);
    }

    function test_SetTaxTiersTwap_Updates() public {
        vm.prank(trustees);
        hook.setTaxTiersTwap(5, 0.91e18);
        assertEq(hook.taxTiersTwaps(5), 0.91e18);
    }

    function test_SetTaxTiersRate_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        hook.setTaxTiersRate(0, 100);
    }

    function test_SetTaxTiersRate_RejectsOutOfRange() public {
        vm.prank(trustees);
        vm.expectRevert(PegDefenseHook.TierIndexOutOfRange.selector);
        hook.setTaxTiersRate(14, 100);
    }

    function test_SetTaxTiersRate_RejectsTooHigh() public {
        vm.prank(trustees);
        vm.expectRevert(PegDefenseHook.TaxRateTooHigh.selector);
        hook.setTaxTiersRate(0, 10_001);
    }

    function test_SetTaxTiersRate_Updates() public {
        vm.prank(trustees);
        hook.setTaxTiersRate(0, 1000);
        assertEq(hook.taxTiersRates(0), 1000);
    }

    function test_SetExcludedAddress_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        hook.setExcludedAddress(stranger, true);
    }

    function test_SetExcludedAddress_Updates() public {
        address account = makeAddr("excluded");
        vm.prank(trustees);
        hook.setExcludedAddress(account, true);
        assertTrue(hook.excludedAddresses(account));
        vm.prank(trustees);
        hook.setExcludedAddress(account, false);
        assertFalse(hook.excludedAddresses(account));
    }

    // ---------------------------------------------------------------------
    // Sprint 4b — beforeSwap tax path early returns (no take)
    // ---------------------------------------------------------------------

    function test_BeforeSwap_NoTax_WhenAutoCalculateTaxFalse() public {
        _bind(0);
        pm.setTick(0);
        // autoCalculateTax = false (default). Even on a sell direction, no delta.
        SwapParams memory params = _sellSwap();
        vm.prank(address(pm));
        (, BeforeSwapDelta delta,) = hook.beforeSwap(address(0), poolKey, params, "");
        assertEq(BeforeSwapDelta.unwrap(delta), 0, "no tax delta when autoCalculateTax=false");
        assertEq(pm.takeCallCount(), 0, "no take called");
    }

    function test_BeforeSwap_NoTax_OnBuyDirection() public {
        _bind(0);
        pm.setTick(0);
        vm.prank(trustees);
        hook.setAutoCalculateTax(true);

        // BUY: zeroForOne != moneyIsCurrency0 (the opposite-direction swap).
        SwapParams memory params =
            SwapParams({zeroForOne: !hook.moneyIsCurrency0(), amountSpecified: -100 ether, sqrtPriceLimitX96: 0});
        vm.prank(address(pm));
        (, BeforeSwapDelta delta,) = hook.beforeSwap(address(0), poolKey, params, "");
        assertEq(BeforeSwapDelta.unwrap(delta), 0, "no tax on buy direction");
        assertEq(pm.takeCallCount(), 0, "no take on buy");
    }

    function test_BeforeSwap_NoTax_ForExcludedSender() public {
        _bind(0);
        pm.setTick(0);
        vm.prank(trustees);
        hook.setAutoCalculateTax(true);

        address excludedSender = makeAddr("router");
        vm.prank(trustees);
        hook.setExcludedAddress(excludedSender, true);

        // Sell direction, but the swap's sender is excluded.
        SwapParams memory params = _sellSwap();
        vm.prank(address(pm));
        (, BeforeSwapDelta delta,) = hook.beforeSwap(excludedSender, poolKey, params, "");
        assertEq(BeforeSwapDelta.unwrap(delta), 0, "no tax for excluded sender");
        assertEq(pm.takeCallCount(), 0, "no take for excluded sender");
    }

    // ---------------------------------------------------------------------
    // Sprint 4b — beforeSwap tax path WITH take + burn/route
    // ---------------------------------------------------------------------

    function test_BeforeSwap_BurnsBelowThreshold() public {
        _bind(0); // tick=0, price ~= 1.0 — below default 1.10e18 burnThreshold
        pm.setTick(0);
        vm.prank(trustees);
        hook.setAutoCalculateTax(true);

        // Pre-fund the mock with MONEY so its take() can transfer to the hook.
        // At tick 0, rate is tier 7 = 1500 bps. For amountSpecified = -100, tax = 15.
        uint256 amount = 100 ether;
        uint256 expectedTax = amount * 1500 / 10_000;
        vm.prank(owner);
        money.mint(address(pm), expectedTax);

        uint256 totalBefore = money.totalSupply();

        SwapParams memory params = _sellSwap();
        vm.prank(address(pm));
        (, BeforeSwapDelta delta,) = hook.beforeSwap(address(0), poolKey, params, "");

        // take was called once for expectedTax MONEY -> hook -> burned.
        assertEq(pm.takeCallCount(), 1, "take called once");
        assertEq(pm.lastTakeAmount(), expectedTax, "take amount = tax");
        assertEq(pm.lastTakeRecipient(), address(hook), "take recipient = hook");
        assertEq(money.totalSupply(), totalBefore - expectedTax, "totalSupply decreased by tax");
        assertEq(money.balanceOf(address(hook)), 0, "hook balance is 0 after burn");
        // Delta encodes the tax in the specified slot (exact-input).
        int128 deltaSpecified = BeforeSwapDeltaLibrary.getSpecifiedDelta(delta);
        assertEq(int256(deltaSpecified), int256(expectedTax), "deltaSpecified = +taxAmount");
    }

    function test_BeforeSwap_RoutesAboveThreshold() public {
        _bind(0);
        pm.setTick(0); // tick 0 -> price ~= 1.0
        // Set burnThreshold below the current price so the route path is exercised.
        vm.prank(trustees);
        hook.setBurnThreshold(0.5e18);
        vm.prank(trustees);
        hook.setAutoCalculateTax(true);

        address treasuryAddr = makeAddr("treasury");
        vm.prank(trustees);
        hook.setTreasury(treasuryAddr);

        uint256 amount = 100 ether;
        // At tick 0 price ~= 1.0, that's tier 7 -> 1500 bps.
        uint256 expectedTax = amount * 1500 / 10_000;
        vm.prank(owner);
        money.mint(address(pm), expectedTax);

        uint256 totalBefore = money.totalSupply();

        SwapParams memory params = _sellSwap();
        vm.prank(address(pm));
        hook.beforeSwap(address(0), poolKey, params, "");

        // Total supply unchanged (no burn); treasury holds the tax.
        assertEq(money.totalSupply(), totalBefore, "totalSupply unchanged when routed");
        assertEq(money.balanceOf(treasuryAddr), expectedTax, "treasury received tax");
        assertEq(money.balanceOf(address(hook)), 0, "hook balance is 0 after transfer");
    }

    function test_BeforeSwap_FallsBackToBurn_WhenTreasuryUnset() public {
        _bind(0);
        pm.setTick(0);
        // Lower burnThreshold to flip into the would-be-route branch, but leave treasury unset.
        vm.prank(trustees);
        hook.setBurnThreshold(0.5e18);
        vm.prank(trustees);
        hook.setAutoCalculateTax(true);
        assertEq(hook.treasury(), address(0), "precondition: treasury unset");

        uint256 amount = 100 ether;
        uint256 expectedTax = amount * 1500 / 10_000;
        vm.prank(owner);
        money.mint(address(pm), expectedTax);

        uint256 totalBefore = money.totalSupply();

        SwapParams memory params = _sellSwap();
        vm.prank(address(pm));
        hook.beforeSwap(address(0), poolKey, params, "");

        // Treasury is zero, fall through to burn even above threshold.
        assertEq(money.totalSupply(), totalBefore - expectedTax, "burn fallback fires");
        assertEq(money.balanceOf(address(hook)), 0, "hook balance is 0 after burn");
    }

    // ---------------------------------------------------------------------
    // Sprint 4b — fuzz invariants
    // ---------------------------------------------------------------------

    function testFuzz_TaxConservation_BurnPath(
        uint256 sellAmount
    ) public {
        sellAmount = bound(sellAmount, 1, 1000 ether);
        _bind(0);
        pm.setTick(0);
        vm.prank(trustees);
        hook.setAutoCalculateTax(true);

        uint256 expectedTax = sellAmount * 1500 / 10_000;
        if (expectedTax == 0) return;

        vm.prank(owner);
        money.mint(address(pm), expectedTax);

        uint256 totalBefore = money.totalSupply();

        SwapParams memory params = SwapParams({
            zeroForOne: hook.moneyIsCurrency0(), amountSpecified: -int256(sellAmount), sqrtPriceLimitX96: 0
        });
        vm.prank(address(pm));
        hook.beforeSwap(address(0), poolKey, params, "");

        assertEq(money.totalSupply(), totalBefore - expectedTax, "supply decrease == expected tax");
        assertEq(money.balanceOf(address(hook)), 0, "hook never holds MONEY post-beforeSwap");
    }

    function testFuzz_TaxConservation_RoutePath(
        uint256 sellAmount
    ) public {
        sellAmount = bound(sellAmount, 1, 1000 ether);
        _bind(0);
        pm.setTick(0);

        vm.prank(trustees);
        hook.setBurnThreshold(0.5e18);
        vm.prank(trustees);
        hook.setAutoCalculateTax(true);

        address treasuryAddr = makeAddr("treasury_fuzz");
        vm.prank(trustees);
        hook.setTreasury(treasuryAddr);

        uint256 expectedTax = sellAmount * 1500 / 10_000;
        if (expectedTax == 0) return;

        vm.prank(owner);
        money.mint(address(pm), expectedTax);

        uint256 totalBefore = money.totalSupply();
        uint256 treasuryBefore = money.balanceOf(treasuryAddr);

        SwapParams memory params = SwapParams({
            zeroForOne: hook.moneyIsCurrency0(), amountSpecified: -int256(sellAmount), sqrtPriceLimitX96: 0
        });
        vm.prank(address(pm));
        hook.beforeSwap(address(0), poolKey, params, "");

        assertEq(money.totalSupply(), totalBefore, "supply unchanged on route");
        assertEq(money.balanceOf(treasuryAddr), treasuryBefore + expectedTax, "treasury += expected tax");
        assertEq(money.balanceOf(address(hook)), 0, "hook never holds MONEY post-beforeSwap");
    }

    function testFuzz_TierLookup_AlwaysReturnsValidRate(
        uint256 price
    ) public view {
        uint256 rate = hook.taxRateForPrice(price);
        assertTrue(
            rate == 100 || rate == 200 || rate == 400 || rate == 900 || rate == 1400 || rate == 1500 || rate == 1600
                || rate == 1700 || rate == 1800 || rate == 1900 || rate == 2000,
            "rate must be one of the 14 Tomb tiers"
        );
    }

    function testFuzz_BuyDirection_NeverTaxed(
        uint256 amount
    ) public {
        amount = bound(amount, 1, 1000 ether);
        _bind(0);
        pm.setTick(0);
        vm.prank(trustees);
        hook.setAutoCalculateTax(true);

        SwapParams memory params =
            SwapParams({zeroForOne: !hook.moneyIsCurrency0(), amountSpecified: -int256(amount), sqrtPriceLimitX96: 0});

        uint256 supplyBefore = money.totalSupply();
        uint256 takesBefore = pm.takeCallCount();

        vm.prank(address(pm));
        hook.beforeSwap(address(0), poolKey, params, "");

        assertEq(money.totalSupply(), supplyBefore, "buy never reduces supply");
        assertEq(pm.takeCallCount(), takesBefore, "buy never triggers take");
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _bind(
        int24 initialTick
    ) internal {
        vm.prank(address(pm));
        hook.afterInitialize(address(0), poolKey, 0, initialTick);
    }

    function _emptySwap() internal pure returns (SwapParams memory) {
        return SwapParams({zeroForOne: true, amountSpecified: 0, sqrtPriceLimitX96: 0});
    }

    /// @dev Exact-input MONEY sell. zeroForOne == moneyIsCurrency0 means MONEY -> other.
    ///      amountSpecified < 0 = exact-input. 100e18 MONEY in.
    function _sellSwap() internal view returns (SwapParams memory) {
        return SwapParams({zeroForOne: hook.moneyIsCurrency0(), amountSpecified: -100 ether, sqrtPriceLimitX96: 0});
    }

    function _beforeSwapCall() internal returns (bytes4 sel, BeforeSwapDelta delta, uint24 fee) {
        vm.prank(address(pm));
        (sel, delta, fee) = hook.beforeSwap(address(0), poolKey, _emptySwap(), "");
    }
}
