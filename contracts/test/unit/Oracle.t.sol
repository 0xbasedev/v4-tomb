// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";
import {MockPriceSource} from "../utils/MockPriceSource.sol";

import {Oracle} from "../../src/oracle/Oracle.sol";
import {Epoch} from "../../src/libs/Epoch.sol";
import {Trustees} from "../../src/governance/Trustees.sol";
import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";

import {TickMath} from "v4-core/src/libraries/TickMath.sol";

contract OracleTest is BaseTest {
    MockPriceSource internal source;
    Oracle internal oracle;

    address internal tokenLow = address(0x1111111111111111111111111111111111111111);
    address internal tokenHigh = address(0x2222222222222222222222222222222222222222);

    // Period defaults — Tomb-typical 6 hours.
    uint256 internal constant PERIOD = 6 hours;
    uint256 internal startTime;

    // Reference cumulatives. Start at a non-zero timestamp so subtraction has headroom.
    int56 internal constant INIT_CUM = 0;
    uint32 internal INIT_TS;

    function setUp() public override {
        super.setUp();
        vm.label(tokenLow, "tokenLow");
        vm.label(tokenHigh, "tokenHigh");

        // Warp to a sane non-zero block timestamp.
        vm.warp(1_700_000_000);

        INIT_TS = uint32(block.timestamp);
        startTime = block.timestamp + 1 hours;

        source = new MockPriceSource(INIT_CUM, INIT_TS);

        vm.prank(owner);
        oracle = new Oracle(IPriceSource(address(source)), tokenLow, tokenHigh, PERIOD, startTime);
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    function test_Constructor_SortsTokens() public view {
        assertEq(oracle.token0(), tokenLow);
        assertEq(oracle.token1(), tokenHigh);
    }

    function test_Constructor_SortsTokens_ReversedArgs() public {
        Oracle reversed = new Oracle(IPriceSource(address(source)), tokenHigh, tokenLow, PERIOD, startTime);
        assertEq(reversed.token0(), tokenLow);
        assertEq(reversed.token1(), tokenHigh);
    }

    function test_Constructor_RejectsIdenticalTokens() public {
        vm.expectRevert(Oracle.IdenticalTokens.selector);
        new Oracle(IPriceSource(address(source)), tokenLow, tokenLow, PERIOD, startTime);
    }

    function test_Constructor_StoresPriceSource() public view {
        assertEq(address(oracle.priceSource()), address(source));
    }

    function test_Constructor_StoresEpochParams() public view {
        assertEq(oracle.getPeriod(), PERIOD);
        assertEq(oracle.getStartTime(), startTime);
        assertEq(oracle.nextEpochPoint(), startTime);
    }

    function test_Constructor_SnapshotsInitialCumulative() public view {
        assertEq(oracle.tickCumulativeLast(), INIT_CUM);
        assertEq(oracle.blockTimestampLast(), INIT_TS);
        assertFalse(oracle.initialized());
        assertEq(oracle.averageTick(), 0);
    }

    // ---------------------------------------------------------------------
    // Pre-update: consult returns 0
    // ---------------------------------------------------------------------

    function test_Consult_ZeroBeforeFirstUpdate() public view {
        assertEq(oracle.consult(tokenLow, 1e18), 0);
        assertEq(oracle.consult(tokenHigh, 1e18), 0);
    }

    // ---------------------------------------------------------------------
    // update() — epoch gating
    // ---------------------------------------------------------------------

    function test_Update_PreEpochOnlyTrustees() public {
        // Right at deploy, block.timestamp < startTime → pre-epoch.
        vm.prank(stranger);
        vm.expectRevert(Epoch.PreEpochNotTrustees.selector);
        oracle.update();
    }

    function test_Update_PreEpochTrusteesAllowed() public {
        // Trustees (owner by default — set in BaseTest deploy of Oracle) can call early.
        // But because timeElapsed will be 0 (no advance since construction), it's a no-op.
        vm.prank(owner);
        oracle.update();
        assertFalse(oracle.initialized());
    }

    function test_Update_AnyoneAfterPeriod() public {
        // Advance the price source forward one period at a constant tick of 0
        // (TWAP averages to 0, which corresponds to a 1:1 price).
        source.advance(0, uint32(PERIOD + 1));
        vm.warp(block.timestamp + PERIOD + 1);

        vm.prank(stranger);
        oracle.update();
        assertTrue(oracle.initialized());
        assertEq(oracle.averageTick(), 0);
        assertEq(oracle.getCurrentEpoch(), 1);
    }

    function test_Update_TwapAtTickZero_PricesAtParity() public {
        // tick=0 → sqrtP = 2^96 → price ratio = 1.
        source.advance(0, uint32(PERIOD + 1));
        vm.warp(block.timestamp + PERIOD + 1);
        vm.prank(stranger);
        oracle.update();

        // 1e18 of either token quotes to ~1e18 of the other at tick 0.
        assertApproxEqAbs(oracle.consult(tokenLow, 1e18), 1e18, 1);
        assertApproxEqAbs(oracle.consult(tokenHigh, 1e18), 1e18, 1);
    }

    function test_Update_PositiveTick_FavorsToken1() public {
        // Positive tick = token0 worth MORE in token1 terms.
        // At tick 6932 ≈ ln(2)/ln(1.0001), price ≈ 2.0.
        int24 tick = 6932;
        source.advance(tick, uint32(PERIOD + 1));
        vm.warp(block.timestamp + PERIOD + 1);
        vm.prank(stranger);
        oracle.update();

        // 1 token0 ≈ 2 token1.
        uint256 token1Out = oracle.consult(tokenLow, 1e18);
        assertApproxEqRel(token1Out, 2e18, 0.001e18); // within 0.1%

        // 1 token1 ≈ 0.5 token0.
        uint256 token0Out = oracle.consult(tokenHigh, 1e18);
        assertApproxEqRel(token0Out, 0.5e18, 0.001e18);
    }

    function test_Update_TimeElapsedZero_IsNoop() public {
        // Trustees calls right after construction → timeElapsed = 0 → silent no-op.
        vm.prank(owner);
        oracle.update();
        assertEq(oracle.averageTick(), 0);
        assertFalse(oracle.initialized());
    }

    function test_Update_AdvancesEpoch() public {
        source.advance(0, uint32(PERIOD + 1));
        vm.warp(block.timestamp + PERIOD + 1);
        oracle.update();
        assertEq(oracle.getCurrentEpoch(), 1);

        // Second period.
        source.advance(0, uint32(PERIOD + 1));
        vm.warp(block.timestamp + PERIOD + 1);
        oracle.update();
        assertEq(oracle.getCurrentEpoch(), 2);
    }

    // ---------------------------------------------------------------------
    // twap() — recomputes from current cumulatives
    // ---------------------------------------------------------------------

    function test_Twap_UnknownToken_ReturnsZero() public view {
        assertEq(oracle.twap(stranger, 1e18), 0);
    }

    function test_Twap_RecomputesWithoutUpdate() public {
        // Advance source by 1 hour at tick 0. update() not called.
        source.advance(0, 3600);
        vm.warp(block.timestamp + 3600);
        // twap should still return ~parity even though averageTick is still 0 and consult returns 0.
        assertApproxEqAbs(oracle.twap(tokenLow, 1e18), 1e18, 1);
        assertEq(oracle.consult(tokenLow, 1e18), 0);
    }

    function test_Twap_TimeElapsedZero_ReturnsZeroIfNotInitialized() public view {
        // No source advance, no update → timeElapsed=0, !initialized → 0.
        assertEq(oracle.twap(tokenLow, 1e18), 0);
    }

    // ---------------------------------------------------------------------
    // consult() — quote consistency
    // ---------------------------------------------------------------------

    function test_Consult_RevertsOnUnknownToken() public {
        // First initialize so we reach the _tickToAmount path.
        source.advance(0, uint32(PERIOD + 1));
        vm.warp(block.timestamp + PERIOD + 1);
        oracle.update();

        vm.expectRevert(Oracle.InvalidToken.selector);
        oracle.consult(stranger, 1e18);
    }

    // ---------------------------------------------------------------------
    // Epoch governance (setPeriod / setEpoch)
    // ---------------------------------------------------------------------

    function test_SetPeriod_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        oracle.setPeriod(12 hours);
    }

    function test_SetPeriod_RejectsTooSmall() public {
        vm.prank(owner);
        vm.expectRevert(Epoch.PeriodOutOfRange.selector);
        oracle.setPeriod(59 minutes);
    }

    function test_SetPeriod_RejectsTooLarge() public {
        vm.prank(owner);
        vm.expectRevert(Epoch.PeriodOutOfRange.selector);
        oracle.setPeriod(49 hours);
    }

    function test_SetPeriod_AcceptsBoundary() public {
        vm.prank(owner);
        oracle.setPeriod(1 hours);
        assertEq(oracle.getPeriod(), 1 hours);
        vm.prank(owner);
        oracle.setPeriod(48 hours);
        assertEq(oracle.getPeriod(), 48 hours);
    }

    function test_SetEpoch_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        oracle.setEpoch(42);
    }

    function test_SetEpoch_Rotates() public {
        vm.prank(owner);
        oracle.setEpoch(42);
        assertEq(oracle.getCurrentEpoch(), 42);
    }

    // ---------------------------------------------------------------------
    // Trustees rotation (from Trustees base)
    // ---------------------------------------------------------------------

    function test_TransferTrustees_AffectsPreEpochAuthority() public {
        vm.prank(owner);
        oracle.transferTrustees(alice);

        // Previous trustees (owner) can no longer call pre-epoch.
        vm.prank(owner);
        vm.expectRevert(Epoch.PreEpochNotTrustees.selector);
        oracle.update();

        // New trustees can.
        vm.prank(alice);
        oracle.update(); // no-op because timeElapsed = 0, but does not revert
    }
}
