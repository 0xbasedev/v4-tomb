// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MasonryRules} from "../../src/masonry/MasonryRules.sol";

contract MasonryRulesTest is Test {
    function test_ExactDefaultSquareSupply() public pure {
        uint256[4] memory vested = [uint256(6941), uint256(0), uint256(0), uint256(0)];
        MasonryRules.validateSquareAllocations(33_333, 25_641, 100, 1, 100, 500, 50, vested);
    }

    function test_DefaultAllocationsCannotOverMint() public {
        uint256[4] memory vested = [uint256(6942), uint256(0), uint256(0), uint256(0)];
        vm.expectRevert(abi.encodeWithSelector(MasonryRules.SupplyNotReconciled.selector, 33_334, 33_333));
        this.validateSquareAllocations(vested);
    }

    uint16 private constant TOMB = MasonryRules.DEFAULT_BASE_FIRE_TAX_BPS;
    uint16 private constant SHARE = MasonryRules.SHARE_BASE_SELL_TAX_BPS;
    uint16 private constant WITHDRAW = MasonryRules.WITHDRAW_BASE_FEE_BPS;
    uint16 private constant CAP = MasonryRules.HARD_MAX_FIRE_TAX_BPS;
    uint16 private constant DROP = MasonryRules.DEFAULT_FULL_TAX_DROP_BPS;

    function test_OwnerRatesAreHardCoded() public pure {
        assertEq(TOMB, 50); // X Tomb sells: 0.5% at or above peg
        assertEq(SHARE, 300); // X Share sells: 3% at or above peg
        assertEq(WITHDRAW, 150); // withdrawals: 1.5% at or above peg
        assertEq(CAP, 600); // 6% for all three
        assertEq(MasonryRules.DEFAULT_MAX_FIRE_TAX_BPS, 600);
        assertEq(DROP, 1000); // reached 10% under peg
        assertEq(MasonryRules.GENESIS_TAX_BPS, 600);
        assertEq(MasonryRules.GENESIS_TAX_DECAY_BPS, 30);
        assertEq(MasonryRules.EPOCH, 6 hours);
    }

    function test_XTombCurveBreakpoints() public pure {
        assertEq(MasonryRules.targetSellTaxBps(12e17, 1e18, TOMB, CAP, DROP), 50); // above peg
        assertEq(MasonryRules.targetSellTaxBps(1e18, 1e18, TOMB, CAP, DROP), 50); // at peg
        assertEq(MasonryRules.targetSellTaxBps(1e18 - 1, 1e18, TOMB, CAP, DROP), 50); // dust below peg
        assertEq(MasonryRules.targetSellTaxBps(98e16, 1e18, TOMB, CAP, DROP), 295); // 2% below
        assertEq(MasonryRules.targetSellTaxBps(95e16, 1e18, TOMB, CAP, DROP), 438); // 5% below
        assertEq(MasonryRules.targetSellTaxBps(90e16 + 1, 1e18, TOMB, CAP, DROP), 599);
        assertEq(MasonryRules.targetSellTaxBps(90e16, 1e18, TOMB, CAP, DROP), 600); // 10% below
        assertEq(MasonryRules.targetSellTaxBps(50e16, 1e18, TOMB, CAP, DROP), 600);
        assertEq(MasonryRules.targetSellTaxBps(0, 1e18, TOMB, CAP, DROP), 600);
    }

    function test_XShareCurveBreakpoints() public pure {
        assertEq(MasonryRules.targetSellTaxBps(11e17, 1e18, SHARE, CAP, DROP), 300); // above peg
        assertEq(MasonryRules.targetSellTaxBps(1e18, 1e18, SHARE, CAP, DROP), 300); // at peg
        assertEq(MasonryRules.targetSellTaxBps(98e16, 1e18, SHARE, CAP, DROP), 434); // 2% below
        assertEq(MasonryRules.targetSellTaxBps(95e16, 1e18, SHARE, CAP, DROP), 512); // 5% below
        assertEq(MasonryRules.targetSellTaxBps(90e16, 1e18, SHARE, CAP, DROP), 600); // 10% below
        assertEq(MasonryRules.targetSellTaxBps(1, 1e18, SHARE, CAP, DROP), 600);
    }

    function testFuzz_SqrtCurveMonotonic(
        uint128 a,
        uint128 b
    ) public pure {
        (uint256 lo, uint256 hi) = a < b ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
        assertGe(
            MasonryRules.targetSellTaxBps(lo, 1e18, TOMB, CAP, DROP),
            MasonryRules.targetSellTaxBps(hi, 1e18, TOMB, CAP, DROP)
        );
    }

    /// Fast up: the square-root curve is never below a straight line from base to cap.
    function testFuzz_SqrtCurveAtLeastLinear(
        uint64 price
    ) public pure {
        uint256 p = bound(uint256(price), 9e17, 1e18);
        uint256 progress = (1e18 - p) * 10_000 / 1e17;
        uint256 linear = TOMB + uint256(CAP - TOMB) * progress / 10_000;
        assertGe(MasonryRules.targetSellTaxBps(p, 1e18, TOMB, CAP, DROP), linear);
    }

    function test_FireTaxHardCapRejectsHigherValue() public {
        vm.expectRevert(MasonryRules.InvalidParameters.selector);
        this.targetSellTaxBps(601);
    }

    function test_ProjectedSellRaisesTaxOnSameTrade() public pure {
        uint16 twap = MasonryRules.targetSellTaxBps(1e18, 1e18, TOMB, CAP, DROP);
        uint16 projected = MasonryRules.targetSellTaxBps(85e16, 1e18, TOMB, CAP, DROP);
        assertEq(MasonryRules.effectiveSellTaxBps(twap, projected, TOMB), 600);
    }

    /// Slow down: a raised rate falls back to the base over seven hours.
    function test_SevenHourTaxRecovery() public pure {
        uint256 start = 100_000;
        assertEq(MasonryRules.recoveryFloorBps(600, TOMB, start, start), 600);
        assertEq(MasonryRules.recoveryFloorBps(600, TOMB, start, start + 3.5 hours), 325);
        assertEq(MasonryRules.recoveryFloorBps(600, TOMB, start, start + 7 hours - 1), 50);
        assertEq(MasonryRules.recoveryFloorBps(600, TOMB, start, start + 7 hours), 50);
        assertEq(MasonryRules.recoveryFloorBps(600, SHARE, start, start + 3.5 hours), 450);
        assertEq(MasonryRules.recoveryFloorBps(600, SHARE, start, start + 30 days), 300);
    }

    function test_GenesisTaxIsSixPercentThenFallsThirtyBpsPerEpoch() public pure {
        uint256 end = 1_000_000;
        assertEq(MasonryRules.genesisTaxFloorBps(false, 0, end), 0); // no start set
        assertEq(MasonryRules.genesisTaxFloorBps(false, end, end - 8 days), 0); // before Genesis
        assertEq(MasonryRules.genesisTaxFloorBps(true, end, end - 1), 600);
        assertEq(MasonryRules.genesisTaxFloorBps(false, end, end), 600);
        assertEq(MasonryRules.genesisTaxFloorBps(false, end, end + 6 hours - 1), 600);
        assertEq(MasonryRules.genesisTaxFloorBps(false, end, end + 6 hours), 570);
        assertEq(MasonryRules.genesisTaxFloorBps(false, end, end + 19 * 6 hours), 30);
        assertEq(MasonryRules.genesisTaxFloorBps(false, end, end + 20 * 6 hours), 0);
        assertEq(MasonryRules.genesisTaxFloorBps(false, end, end + 3650 days), 0);
    }

    function test_WithdrawFeeIsOnePointFiveToSixPercentWithDecay() public pure {
        uint256 peg = 1e18;
        uint256 t0 = 1_000_000;
        assertEq(MasonryRules.withdrawFeeBps(peg, peg, WITHDRAW, CAP, DROP, TOMB, t0, t0), 150);
        assertEq(MasonryRules.withdrawFeeBps(98e16, peg, WITHDRAW, CAP, DROP, TOMB, t0, t0), 351);
        assertEq(MasonryRules.withdrawFeeBps(90e16, peg, WITHDRAW, CAP, DROP, TOMB, t0, t0), 600);
        assertEq(MasonryRules.withdrawFeeBps(70e16, peg, WITHDRAW, CAP, DROP, TOMB, t0, t0), 600);
        assertEq(MasonryRules.withdrawFeeBps(peg, peg, WITHDRAW, CAP, DROP, 600, t0, t0), 600);
        assertEq(MasonryRules.withdrawFeeBps(peg, peg, WITHDRAW, CAP, DROP, 600, t0, t0 + 3.5 hours), 375);
        assertEq(MasonryRules.withdrawFeeBps(peg, peg, WITHDRAW, CAP, DROP, 600, t0, t0 + 7 hours), 150);
    }

    function testFuzz_WithdrawFeeStaysBetweenOnePointFiveAndSixPercent(
        uint128 price,
        uint16 raised,
        uint32 elapsed
    ) public pure {
        uint16 r = uint16(bound(raised, TOMB, CAP));
        uint16 fee =
            MasonryRules.withdrawFeeBps(price == 0 ? 1 : uint256(price), 1e18, WITHDRAW, CAP, DROP, r, 0, elapsed);
        assertGe(fee, 150);
        assertLe(fee, 600);
    }

    function test_ExpansionRequiresStrictlyAboveOnePointZeroOne() public pure {
        assertFalse(MasonryRules.eligibleForExpansion(101e16, 1e18, true));
        assertTrue(MasonryRules.eligibleForExpansion(101e16 + 1, 1e18, true));
        assertFalse(MasonryRules.eligibleForExpansion(102e16, 1e18, false));
        assertEq(MasonryRules.expansionUpperBound(100_000e18, 200, 102e16, 1e18, true), 2000e18);
        assertEq(MasonryRules.expansionUpperBound(100_000e18, 200, 102e16, 1e18, false), 0);
    }

    function test_ExpansionGreaterThanTwoPercentReverts() public {
        vm.expectRevert(MasonryRules.InvalidParameters.selector);
        this.expansionUpperBound(201);
    }

    function testFuzz_FireTaxNeverExceedsSixPercent(
        uint128 price
    ) public pure {
        uint16 tax = MasonryRules.targetSellTaxBps(uint256(price), 1e18, TOMB, CAP, DROP);
        assertGe(tax, 50);
        assertLe(tax, 600);
    }

    function testFuzz_RecoveryNeverExceedsSixPercent(
        uint32 elapsed
    ) public pure {
        uint16 tax = MasonryRules.recoveryFloorBps(600, TOMB, 100, 100 + uint256(elapsed));
        assertGe(tax, 50);
        assertLe(tax, 600);
    }

    function validateSquareAllocations(
        uint256[4] memory vested
    ) external pure {
        MasonryRules.validateSquareAllocations(33_333, 25_641, 100, 1, 100, 500, 50, vested);
    }

    function targetSellTaxBps(
        uint16 maximumBps
    ) external pure {
        MasonryRules.targetSellTaxBps(90e16, 1e18, 50, maximumBps, 1000);
    }

    function expansionUpperBound(
        uint16 requestedRateBps
    ) external pure {
        MasonryRules.expansionUpperBound(100_000e18, requestedRateBps, 102e16, 1e18, true);
    }
}
