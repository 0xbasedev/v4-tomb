// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";
import {MockOracle} from "../utils/MockOracle.sol";

import {PegDefenseHook, PegDefenseHookPermissions} from "../../src/hooks/PegDefenseHook.sol";
import {BaseV4Hook} from "../../src/hooks/base/BaseV4Hook.sol";
import {PegToken} from "../../src/tokens/PegToken.sol";
import {Trustees} from "../../src/governance/Trustees.sol";

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal pool manager stub: implements only `extsload(bytes32)` so the hook can
///         read Slot0 via V4's StateLibrary, plus a `take` stub for Sprint 4b tax tests.
///         `setTick` packs the tick into the slot0 layout.
contract MockPoolManager {
    bytes32 public slot0Data;

    // Sprint 4b — when the hook calls poolManager.take(currency, to, amount) in beforeSwap
    // to pull a tax slice into its balance, we simulate it by transferring from the mock's
    // own balance. Tests must pre-fund the mock with PEG before exercising tax paths.
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

/// @dev An oracle whose `consult` always fails.
contract RevertingOracle {
    function consult(
        address,
        uint256
    ) external pure returns (uint144) {
        revert("oracle down");
    }
}

contract PegDefenseHookTest is BaseTest {
    using PoolIdLibrary for PoolKey;

    PegDefenseHook internal hook;
    MockPoolManager internal pm;
    PegToken internal peg;
    address internal weth = makeAddr("weth");
    PoolKey internal poolKey;

    address internal hookAddr;

    function setUp() public override {
        super.setUp();
        vm.label(weth, "weth");

        vm.warp(1_700_000_000);

        pm = new MockPoolManager();

        vm.prank(owner);
        peg = new PegToken("Peg Token", "PEG");

        // The lowest address carrying exactly the hook's permission bits.
        hookAddr = address(PegDefenseHookPermissions.FLAGS);

        deployCodeTo(
            "PegDefenseHook.sol:PegDefenseHook",
            abi.encode(IPoolManager(address(pm)), address(peg), address(this)),
            hookAddr
        );
        hook = PegDefenseHook(hookAddr);

        // Sort the two tokens into V4 currency order.
        (Currency c0, Currency c1) = address(peg) < weth
            ? (Currency.wrap(address(peg)), Currency.wrap(weth))
            : (Currency.wrap(weth), Currency.wrap(address(peg)));

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
        assertEq(hook.peg(), address(peg));
    }

    function test_HookPermissions_MatchDeclaredFlags() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.afterInitialize);
        assertTrue(p.beforeSwap);
        assertTrue(p.afterSwap, "afterSwap records the post-swap tick");
        assertTrue(p.beforeSwapReturnDelta, "exact-input sell tax");
        assertTrue(p.afterSwapReturnDelta, "exact-output sell tax");
        assertFalse(p.beforeInitialize);
        assertFalse(p.beforeAddLiquidity);
        assertFalse(p.afterAddLiquidity);
        assertFalse(p.beforeRemoveLiquidity);
        assertFalse(p.afterRemoveLiquidity);
        assertFalse(p.beforeDonate);
        assertFalse(p.afterDonate);
        assertFalse(p.afterAddLiquidityReturnDelta);
        assertFalse(p.afterRemoveLiquidityReturnDelta);

        assertEq(hook.PERMISSION_FLAGS(), 0x10CC, "low-14-bit address pattern");
        assertEq(uint160(address(hook)) & 0x3FFF, hook.PERMISSION_FLAGS());
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

    function test_AfterInitialize_DetectsPegOrientation() public {
        vm.prank(address(pm));
        hook.afterInitialize(address(0), poolKey, 0, 0);
        // PEG is currency0 iff its address is the lower of the two.
        bool expectedIsCurrency0 = address(peg) < weth;
        assertEq(hook.pegIsCurrency0(), expectedIsCurrency0);
    }

    function test_AfterInitialize_OneShot() public {
        vm.prank(address(pm));
        hook.afterInitialize(address(0), poolKey, 0, 0);

        vm.prank(address(pm));
        vm.expectRevert(PegDefenseHook.AlreadyBound.selector);
        hook.afterInitialize(address(0), poolKey, 0, 0);
    }

    function test_AfterInitialize_RejectsPoolMissingPeg() public {
        address otherA = makeAddr("otherA");
        address otherB = makeAddr("otherB");
        (Currency c0, Currency c1) = otherA < otherB
            ? (Currency.wrap(otherA), Currency.wrap(otherB))
            : (Currency.wrap(otherB), Currency.wrap(otherA));
        PoolKey memory badKey = PoolKey({
            currency0: c0, currency1: c1, fee: LPFeeLibrary.DYNAMIC_FEE_FLAG, tickSpacing: 60, hooks: IHooks(hookAddr)
        });

        vm.prank(address(pm));
        vm.expectRevert(PegDefenseHook.PoolMissingPeg.selector);
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
        // 200 ticks above peg, PEG is whichever side is currency0/1.
        // If peg is currency0, currentTick > pegTick == "PEG appreciating" -> expansion.
        // If peg is currency1, we need currentTick LESS than peg to be expansion. Flip sign.
        int24 t = hook.pegIsCurrency0() ? int24(200) : int24(-200);
        pm.setTick(t);

        (,, uint24 feeOverride) = _beforeSwapCall();
        assertEq(feeOverride, uint24(1000) | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function test_BeforeSwap_ReturnsContractionFeeBelowPeg() public {
        _bind(0);
        int24 t = hook.pegIsCurrency0() ? int24(-150) : int24(150);
        pm.setTick(t);

        (,, uint24 feeOverride) = _beforeSwapCall();
        assertEq(feeOverride, uint24(10_000) | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function test_BeforeSwap_ReturnsDeepContractionFeeFarBelowPeg() public {
        _bind(0);
        int24 t = hook.pegIsCurrency0() ? int24(-500) : int24(500);
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
        assertEq(hook.feeRecipient(), address(0), "treasury unset at deploy");
        assertEq(hook.getTaxTiersTwapsCount(), 3, "three tiers");
        assertEq(hook.getTaxTiersRatesCount(), 3, "three rates");
        assertEq(address(hook.taxOracle()), address(0), "tax oracle unset at deploy");
    }

    function test_Tax_TierTable_Defaults() public view {
        uint256[3] memory expectedTwaps = [uint256(0), 1.12e18, 1.2e18];
        uint256[3] memory expectedRates = [uint256(1200), 600, 300];
        for (uint256 i = 0; i < 3; ++i) {
            assertEq(hook.taxTiersTwaps(i), expectedTwaps[i], "twap mismatch");
            assertEq(hook.taxTiersRates(i), expectedRates[i], "rate mismatch");
        }
    }

    function test_Tax_RateLookup_TierBoundaries() public view {
        assertEq(hook.taxRateForPrice(0), 1200, "deep depeg -> 12%");
        assertEq(hook.taxRateForPrice(1.0e18), 1200, "at peg -> 12%");
        assertEq(hook.taxRateForPrice(1.12e18 - 1), 1200, "just below 1.12 -> 12%");
        assertEq(hook.taxRateForPrice(1.12e18), 600, "exactly 1.12 -> 6%");
        assertEq(hook.taxRateForPrice(1.2e18 - 1), 600, "just below 1.20 -> 6%");
        assertEq(hook.taxRateForPrice(1.2e18), 300, "exactly 1.20 -> 3%");
        assertEq(hook.taxRateForPrice(5.0e18), 300, "far above -> 3%");
    }

    // ---------------------------------------------------------------------
    // Tax price source — oracle TWAP with spot fallback
    // ---------------------------------------------------------------------

    function test_SetTaxOracle_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        hook.setTaxOracle(address(1));
    }

    function test_TaxPrice_FallsBackToSpot_WhenOracleUnset() public {
        _bind(0);
        assertApproxEqAbs(hook.currentTaxPrice(), 1e18, 1, "spot at tick 0");
        assertEq(hook.currentTaxRate(), 1200);
    }

    function test_TaxPrice_UsesOracleTwap_NotSpot() public {
        _bind(0); // spot = 1.00 -> would be 12%
        MockOracle oracle = new MockOracle(0);
        oracle.setPrice(1.2e18);
        vm.prank(trustees);
        hook.setTaxOracle(address(oracle));

        assertEq(hook.currentTaxPrice(), 1.2e18, "TWAP wins over spot");
        assertEq(hook.targetTaxRate(), 300, "3% at a 1.20 TWAP");

        oracle.setPrice(1.12e18);
        assertEq(hook.targetTaxRate(), 600, "6% at a 1.12 TWAP");

        oracle.setPrice(1.119e18);
        assertEq(hook.targetTaxRate(), 1200, "12% below 1.12");
    }

    function test_TaxPrice_FallsBackToSpot_WhenOracleReportsZero() public {
        _bind(0);
        MockOracle oracle = new MockOracle(0); // price 0 == no completed epoch yet
        oracle.setPrice(0);
        vm.prank(trustees);
        hook.setTaxOracle(address(oracle));
        assertApproxEqAbs(hook.currentTaxPrice(), 1e18, 1);
    }

    function test_TaxPrice_FallsBackToSpot_WhenOracleReverts() public {
        _bind(0);
        address broken = address(new RevertingOracle());
        vm.prank(trustees);
        hook.setTaxOracle(broken);
        assertApproxEqAbs(hook.currentTaxPrice(), 1e18, 1, "a broken oracle must not block or untax sells");
    }

    function test_BeforeSwap_TaxesAtTheTwapTier_EvenWhenSpotDisagrees() public {
        _bind(0);
        pm.setTick(0); // spot says 12%
        MockOracle oracle = new MockOracle(0);
        oracle.setPrice(1.2e18); // TWAP says 3%
        address twapTreasury = makeAddr("treasury_twap");
        vm.startPrank(trustees);
        hook.setTaxOracle(address(oracle));
        hook.setAutoCalculateTax(true);
        hook.setFeeRecipient(twapTreasury);
        vm.stopPrank();

        // Earn the 3% rate: open the recovery window, then let it run.
        hook.pokeTaxRate();
        vm.warp(block.timestamp + 7 hours);

        uint256 expectedTax = 100 ether * 300 / 10_000;
        vm.prank(owner);
        peg.mint(address(pm), expectedTax);

        SwapParams memory params = _sellSwap();
        vm.prank(address(pm));
        (, BeforeSwapDelta delta,) = hook.beforeSwap(address(0), poolKey, params, "");

        assertEq(int256(BeforeSwapDeltaLibrary.getSpecifiedDelta(delta)), int256(expectedTax), "3% of 100");
        // A 1.20 TWAP is above the 1.10 burn threshold, so the tax is routed, not burned.
        assertEq(peg.balanceOf(twapTreasury), expectedTax);
    }

    // ---------------------------------------------------------------------
    // Fire Tax ratchet — immediate increases, seven-hour decreases
    // ---------------------------------------------------------------------

    function _ratchetOracle(
        uint256 price
    ) internal returns (MockOracle oracle) {
        _bind(0);
        oracle = new MockOracle(price);
        vm.prank(trustees);
        hook.setTaxOracle(address(oracle));
    }

    function test_Ratchet_StartsAtTheMaximum() public view {
        assertEq(hook.taxRate(), 1200);
        assertEq(hook.MAX_TAX_BPS(), 1200);
        assertEq(hook.TAX_RECOVERY_PERIOD(), 7 hours);
        assertEq(hook.taxRecoveryStartedAt(), 0);
    }

    function test_Ratchet_Poke_RequiresBoundPool() public {
        vm.expectRevert(PegDefenseHook.UnknownPool.selector);
        hook.pokeTaxRate();
    }

    function test_Ratchet_DecreaseWaitsTheFullSevenHours() public {
        _ratchetOracle(1.2e18); // target 3%
        uint256 t0 = block.timestamp;

        vm.prank(stranger); // permissionless
        assertEq(hook.pokeTaxRate(), 1200, "first sight of a lower target only opens the window");
        assertEq(hook.taxRecoveryStartedAt(), t0);
        assertEq(hook.taxRecoveryRate(), 300);

        vm.warp(t0 + 7 hours - 1);
        assertEq(hook.currentTaxRate(), 1200, "view agrees: not yet");
        assertEq(hook.pokeTaxRate(), 1200);

        vm.warp(t0 + 7 hours);
        assertEq(hook.currentTaxRate(), 300, "view previews the step");
        assertEq(hook.pokeTaxRate(), 300);
        assertEq(hook.taxRecoveryStartedAt(), 0, "window closed");
    }

    function test_Ratchet_IncreaseIsImmediate_AndCancelsAPendingDecrease() public {
        MockOracle oracle = _ratchetOracle(1.2e18);
        hook.pokeTaxRate();
        vm.warp(block.timestamp + 7 hours);
        assertEq(hook.pokeTaxRate(), 300);

        // A decrease toward 3% was earned. Now the TWAP falls back under 1.12.
        oracle.setPrice(1.0e18);
        assertEq(hook.pokeTaxRate(), 1200, "back to 12% on the very next sync");

        // And a window opened part-way through is cancelled by a rise.
        oracle.setPrice(1.2e18);
        hook.pokeTaxRate();
        vm.warp(block.timestamp + 6 hours);
        oracle.setPrice(1.0e18);
        hook.pokeTaxRate();
        assertEq(hook.taxRecoveryStartedAt(), 0, "pending decrease cancelled");
        oracle.setPrice(1.2e18);
        vm.warp(block.timestamp + 2 hours);
        assertEq(hook.pokeTaxRate(), 1200, "the earlier six hours do not count");
    }

    function test_Ratchet_AdoptsTheHighestTargetSeenDuringTheWindow() public {
        MockOracle oracle = _ratchetOracle(1.2e18); // target 3%
        uint256 t0 = block.timestamp;
        hook.pokeTaxRate();

        vm.warp(t0 + 3 hours);
        oracle.setPrice(1.15e18); // target back up to 6%, still below the 12% in force
        hook.pokeTaxRate();
        assertEq(hook.taxRecoveryRate(), 600, "candidate raised; the window keeps running");
        assertEq(hook.taxRecoveryStartedAt(), t0);

        vm.warp(t0 + 7 hours);
        assertEq(hook.pokeTaxRate(), 600, "only a rate that stood the whole window is adopted");
    }

    function test_Ratchet_ADeeperDecreaseNeedsItsOwnWindow() public {
        MockOracle oracle = _ratchetOracle(1.15e18); // target 6%
        uint256 t0 = block.timestamp;
        hook.pokeTaxRate();

        vm.warp(t0 + 6 hours);
        oracle.setPrice(1.25e18); // target 3%, seen one hour before the window closes
        hook.pokeTaxRate();
        assertEq(hook.taxRecoveryRate(), 600, "the 3% target has not stood for seven hours");

        vm.warp(t0 + 7 hours);
        assertEq(hook.pokeTaxRate(), 600);
        assertEq(hook.taxRecoveryRate(), 300, "a fresh window opens for 3%");

        vm.warp(t0 + 14 hours - 1);
        assertEq(hook.pokeTaxRate(), 600);
        vm.warp(t0 + 14 hours);
        assertEq(hook.pokeTaxRate(), 300);
    }

    function testFuzz_Ratchet_NeverExceedsTheCap_NorFallsEarly(
        uint256[8] memory prices,
        uint256[8] memory gaps
    ) public {
        MockOracle oracle = _ratchetOracle(1e18);
        uint256 lastRise = block.timestamp;
        uint256 previous = hook.taxRate();
        for (uint256 i = 0; i < prices.length; ++i) {
            oracle.setPrice(bound(prices[i], 0.5e18, 1.5e18));
            vm.warp(block.timestamp + bound(gaps[i], 0, 10 hours));
            uint256 rate = hook.pokeTaxRate();
            assertLe(rate, 1200, "hard cap");
            if (rate > previous) {
                lastRise = block.timestamp;
            } else if (rate < previous) {
                assertGe(block.timestamp - lastRise, 7 hours, "no decrease within seven hours of a rise");
            }
            previous = rate;
        }
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
        hook.setFeeRecipient(makeAddr("t"));
    }

    function test_SetTreasury_Updates() public {
        address t = makeAddr("treasury");
        vm.prank(trustees);
        hook.setFeeRecipient(t);
        assertEq(hook.feeRecipient(), t);
    }

    function test_SetTaxTiersTwap_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        hook.setTaxTiersTwap(1, 1.15e18);
    }

    function test_SetTaxTiersTwap_RejectsOutOfRange() public {
        vm.prank(trustees);
        vm.expectRevert(PegDefenseHook.TierIndexOutOfRange.selector);
        hook.setTaxTiersTwap(3, 2e18);
    }

    function test_SetTaxTiersTwap_RejectsNonMonotonicDown() public {
        // Setting tier 1 (1.12) to a value <= tier 0 (0) breaks monotonicity.
        vm.prank(trustees);
        vm.expectRevert(PegDefenseHook.NonMonotonicTier.selector);
        hook.setTaxTiersTwap(1, 0);
    }

    function test_SetTaxTiersTwap_RejectsNonMonotonicUp() public {
        // Setting tier 1 to a value >= tier 2 (1.20) breaks monotonicity.
        vm.prank(trustees);
        vm.expectRevert(PegDefenseHook.NonMonotonicTier.selector);
        hook.setTaxTiersTwap(1, 1.2e18);
    }

    function test_SetTaxTiersTwap_Updates() public {
        vm.prank(trustees);
        hook.setTaxTiersTwap(1, 1.15e18);
        assertEq(hook.taxTiersTwaps(1), 1.15e18);
    }

    function test_SetTaxTiersRate_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        hook.setTaxTiersRate(0, 100);
    }

    function test_SetTaxTiersRate_RejectsOutOfRange() public {
        vm.prank(trustees);
        vm.expectRevert(PegDefenseHook.TierIndexOutOfRange.selector);
        hook.setTaxTiersRate(3, 100);
    }

    function test_SetTaxTiersRate_RejectsTooHigh() public {
        vm.prank(trustees);
        vm.expectRevert(PegDefenseHook.TaxRateTooHigh.selector);
        hook.setTaxTiersRate(0, 1201);
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

        // BUY: zeroForOne != pegIsCurrency0 (the opposite-direction swap).
        SwapParams memory params =
            SwapParams({zeroForOne: !hook.pegIsCurrency0(), amountSpecified: -100 ether, sqrtPriceLimitX96: 0});
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

        // Pre-fund the mock with PEG so its take() can transfer to the hook.
        // At tick 0, the rate is 1200 bps. For amountSpecified = -100, tax = 12.
        uint256 amount = 100 ether;
        uint256 expectedTax = amount * 1200 / 10_000;
        vm.prank(owner);
        peg.mint(address(pm), expectedTax);

        uint256 totalBefore = peg.totalSupply();

        SwapParams memory params = _sellSwap();
        vm.prank(address(pm));
        (, BeforeSwapDelta delta,) = hook.beforeSwap(address(0), poolKey, params, "");

        // take was called once for expectedTax PEG -> hook -> burned.
        assertEq(pm.takeCallCount(), 1, "take called once");
        assertEq(pm.lastTakeAmount(), expectedTax, "take amount = tax");
        assertEq(pm.lastTakeRecipient(), address(hook), "take recipient = hook");
        assertEq(peg.totalSupply(), totalBefore - expectedTax, "totalSupply decreased by tax");
        assertEq(peg.balanceOf(address(hook)), 0, "hook balance is 0 after burn");
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
        hook.setFeeRecipient(treasuryAddr);

        uint256 amount = 100 ether;
        // At tick 0 price ~= 1.0, that's the 12% tier.
        uint256 expectedTax = amount * 1200 / 10_000;
        vm.prank(owner);
        peg.mint(address(pm), expectedTax);

        uint256 totalBefore = peg.totalSupply();

        SwapParams memory params = _sellSwap();
        vm.prank(address(pm));
        hook.beforeSwap(address(0), poolKey, params, "");

        // Total supply unchanged (no burn); treasury holds the tax.
        assertEq(peg.totalSupply(), totalBefore, "totalSupply unchanged when routed");
        assertEq(peg.balanceOf(treasuryAddr), expectedTax, "treasury received tax");
        assertEq(peg.balanceOf(address(hook)), 0, "hook balance is 0 after transfer");
    }

    function test_BeforeSwap_FallsBackToBurn_WhenTreasuryUnset() public {
        _bind(0);
        pm.setTick(0);
        // Lower burnThreshold to flip into the would-be-route branch, but leave treasury unset.
        vm.prank(trustees);
        hook.setBurnThreshold(0.5e18);
        vm.prank(trustees);
        hook.setAutoCalculateTax(true);
        assertEq(hook.feeRecipient(), address(0), "precondition: treasury unset");

        uint256 amount = 100 ether;
        uint256 expectedTax = amount * 1200 / 10_000;
        vm.prank(owner);
        peg.mint(address(pm), expectedTax);

        uint256 totalBefore = peg.totalSupply();

        SwapParams memory params = _sellSwap();
        vm.prank(address(pm));
        hook.beforeSwap(address(0), poolKey, params, "");

        // Treasury is zero, fall through to burn even above threshold.
        assertEq(peg.totalSupply(), totalBefore - expectedTax, "burn fallback fires");
        assertEq(peg.balanceOf(address(hook)), 0, "hook balance is 0 after burn");
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

        uint256 expectedTax = sellAmount * 1200 / 10_000;
        if (expectedTax == 0) return;

        vm.prank(owner);
        peg.mint(address(pm), expectedTax);

        uint256 totalBefore = peg.totalSupply();

        SwapParams memory params =
            SwapParams({zeroForOne: hook.pegIsCurrency0(), amountSpecified: -int256(sellAmount), sqrtPriceLimitX96: 0});
        vm.prank(address(pm));
        hook.beforeSwap(address(0), poolKey, params, "");

        assertEq(peg.totalSupply(), totalBefore - expectedTax, "supply decrease == expected tax");
        assertEq(peg.balanceOf(address(hook)), 0, "hook never holds PEG post-beforeSwap");
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
        hook.setFeeRecipient(treasuryAddr);

        uint256 expectedTax = sellAmount * 1200 / 10_000;
        if (expectedTax == 0) return;

        vm.prank(owner);
        peg.mint(address(pm), expectedTax);

        uint256 totalBefore = peg.totalSupply();
        uint256 treasuryBefore = peg.balanceOf(treasuryAddr);

        SwapParams memory params =
            SwapParams({zeroForOne: hook.pegIsCurrency0(), amountSpecified: -int256(sellAmount), sqrtPriceLimitX96: 0});
        vm.prank(address(pm));
        hook.beforeSwap(address(0), poolKey, params, "");

        assertEq(peg.totalSupply(), totalBefore, "supply unchanged on route");
        assertEq(peg.balanceOf(treasuryAddr), treasuryBefore + expectedTax, "treasury += expected tax");
        assertEq(peg.balanceOf(address(hook)), 0, "hook never holds PEG post-beforeSwap");
    }

    function testFuzz_TierLookup_AlwaysReturnsValidRate(
        uint256 price
    ) public view {
        uint256 rate = hook.taxRateForPrice(price);
        assertTrue(rate == 300 || rate == 600 || rate == 1200, "rate must be one of the three tiers");
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
            SwapParams({zeroForOne: !hook.pegIsCurrency0(), amountSpecified: -int256(amount), sqrtPriceLimitX96: 0});

        uint256 supplyBefore = peg.totalSupply();
        uint256 takesBefore = pm.takeCallCount();

        vm.prank(address(pm));
        hook.beforeSwap(address(0), poolKey, params, "");

        assertEq(peg.totalSupply(), supplyBefore, "buy never reduces supply");
        assertEq(pm.takeCallCount(), takesBefore, "buy never triggers take");
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    // ---------------------------------------------------------------------
    // afterSwap
    // ---------------------------------------------------------------------

    function test_AfterSwap_OnlyPoolManager() public {
        _bind(0);
        vm.expectRevert(BaseV4Hook.NotPoolManager.selector);
        hook.afterSwap(address(0), poolKey, _emptySwap(), BalanceDelta.wrap(0), "");
    }

    function test_AfterSwap_RequiresBoundPool() public {
        vm.prank(address(pm));
        vm.expectRevert(PegDefenseHook.UnknownPool.selector);
        hook.afterSwap(address(0), poolKey, _emptySwap(), BalanceDelta.wrap(0), "");
    }

    function test_AfterSwap_RejectsForeignPool() public {
        _bind(0);
        PoolKey memory other = poolKey;
        other.tickSpacing = 10;
        vm.prank(address(pm));
        vm.expectRevert(PegDefenseHook.UnknownPool.selector);
        hook.afterSwap(address(0), other, _emptySwap(), BalanceDelta.wrap(0), "");
    }

    function test_AfterSwap_RecordsPostSwapTick_SoIdleTimeAccruesAtIt() public {
        _bind(0);

        // A swap one hour in: beforeSwap sees tick 0, the swap moves the pool to tick 250.
        vm.warp(block.timestamp + 1 hours);
        pm.setTick(0);
        vm.prank(address(pm));
        hook.beforeSwap(address(0), poolKey, _emptySwap(), "");
        pm.setTick(250);
        vm.prank(address(pm));
        (bytes4 sel, int128 hookDelta) = hook.afterSwap(address(0), poolKey, _emptySwap(), BalanceDelta.wrap(0), "");

        assertEq(sel, IHooks.afterSwap.selector);
        assertEq(hookDelta, 0, "no tax on a zero-amount swap");
        assertEq(hook.lastTick(), 250, "post-swap tick recorded");
        assertEq(hook.tickCumulative(), 0, "the hour before the swap accrued at tick 0");

        // No further swaps. Six idle hours must project at tick 250, not at the stale 0.
        vm.warp(block.timestamp + 6 hours);
        (int56 cumulative,) = hook.getCurrentTickCumulative();
        assertEq(cumulative, int56(250) * int56(uint56(6 hours)));
    }

    function test_SettleDeferredTax_NoOpWhenNothingPending() public {
        // The mock manager has no `unlock`; reaching it would revert.
        hook.settleDeferredTax();
        assertEq(hook.pendingTaxBurn(), 0);
        assertEq(hook.pendingTaxRoute(), 0);
    }

    function test_UnlockCallback_OnlyPoolManager() public {
        vm.expectRevert(BaseV4Hook.NotPoolManager.selector);
        hook.unlockCallback("");
    }

    function _bind(
        int24 initialTick
    ) internal {
        vm.prank(address(pm));
        hook.afterInitialize(address(0), poolKey, 0, initialTick);
    }

    function _emptySwap() internal pure returns (SwapParams memory) {
        return SwapParams({zeroForOne: true, amountSpecified: 0, sqrtPriceLimitX96: 0});
    }

    /// @dev Exact-input PEG sell. zeroForOne == pegIsCurrency0 means PEG -> other.
    ///      amountSpecified < 0 = exact-input. 100e18 PEG in.
    function _sellSwap() internal view returns (SwapParams memory) {
        return SwapParams({zeroForOne: hook.pegIsCurrency0(), amountSpecified: -100 ether, sqrtPriceLimitX96: 0});
    }

    function _beforeSwapCall() internal returns (bytes4 sel, BeforeSwapDelta delta, uint24 fee) {
        vm.prank(address(pm));
        (sel, delta, fee) = hook.beforeSwap(address(0), poolKey, _emptySwap(), "");
    }
}
