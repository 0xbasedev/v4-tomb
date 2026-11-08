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

    function test_TaxAtPegIsOnePercent() public pure {
        assertEq(MasonryRules.targetSellTaxBps(1e18, 1e18, 100, 1200, 1000), 100);
        assertEq(MasonryRules.targetSellTaxBps(12e17, 1e18, 100, 1200, 1000), 100);
    }

    function test_TaxAtOrBelowEightyFiveCentsIsTwelvePercent() public pure {
        assertEq(MasonryRules.targetSellTaxBps(85e16, 1e18, 100, 1200, 1000), 1200);
        assertEq(MasonryRules.targetSellTaxBps(70e16, 1e18, 100, 1200, 1000), 1200);
    }

    function test_SqrtCurveBreakpoints() public pure {
        uint16 d = MasonryRules.DEFAULT_FULL_TAX_DROP_BPS;
        assertEq(d, 1000);
        assertEq(MasonryRules.targetSellTaxBps(1e18, 1e18, 100, 1200, d), 100); // at peg 1.00%
        assertEq(MasonryRules.targetSellTaxBps(98e16, 1e18, 100, 1200, d), 591); // 2% below ~5.9%
        assertEq(MasonryRules.targetSellTaxBps(95e16, 1e18, 100, 1200, d), 877); // 5% below ~8.8%
        assertEq(MasonryRules.targetSellTaxBps(90e16, 1e18, 100, 1200, d), 1200); // 10% below 12%
        assertEq(MasonryRules.targetSellTaxBps(90e16 + 1, 1e18, 100, 1200, d), 1199);
        assertEq(MasonryRules.targetSellTaxBps(50e16, 1e18, 100, 1200, d), 1200);
        assertEq(MasonryRules.targetSellTaxBps(0, 1e18, 100, 1200, d), 1200);
        assertEq(MasonryRules.targetSellTaxBps(105e16, 1e18, 100, 1200, d), 100); // above peg 1%
        assertEq(MasonryRules.targetSellTaxBps(1e18 - 1, 1e18, 100, 1200, d), 100); // dust below peg
    }

    function testFuzz_SqrtCurveMonotonic(uint128 a, uint128 b) public pure {
        (uint256 lo, uint256 hi) = a < b ? (uint256(a), uint256(b)) : (uint256(b), uint256(a));
        uint16 d = MasonryRules.DEFAULT_FULL_TAX_DROP_BPS;
        assertGe(
            MasonryRules.targetSellTaxBps(lo, 1e18, 100, 1200, d),
            MasonryRules.targetSellTaxBps(hi, 1e18, 100, 1200, d)
        );
    }

    function testFuzz_SqrtCurveAtLeastQuadratic(uint64 price) public pure {
        uint256 p = bound(uint256(price), 9e17, 1e18);
        uint256 progress = (1e18 - p) * 10_000 / 1e17;
        uint256 oldTax = 100 + 1100 * (progress * progress / 10_000) / 10_000;
        assertGe(MasonryRules.targetSellTaxBps(p, 1e18, 100, 1200, 1000), oldTax);
    }

    function test_FireTaxHardCapRejectsHigherValue() public {
        vm.expectRevert(MasonryRules.InvalidParameters.selector);
        this.targetSellTaxBps(1201);
    }

    function test_ProjectedSellRaisesTaxOnSameTrade() public pure {
        uint16 twap = MasonryRules.targetSellTaxBps(1e18, 1e18, 100, 1200, 1000);
        uint16 projected = MasonryRules.targetSellTaxBps(85e16, 1e18, 100, 1200, 1000);
        assertEq(MasonryRules.effectiveSellTaxBps(twap, projected, 100), 1200);
    }

    function test_ThreePercentFloorCurveBreakpoints() public pure {
        uint16 b = MasonryRules.DEFAULT_BASE_FIRE_TAX_BPS;
        uint16 m = MasonryRules.DEFAULT_MAX_FIRE_TAX_BPS;
        uint16 d = MasonryRules.DEFAULT_FULL_TAX_DROP_BPS;
        assertEq(b, 300);
        assertEq(MasonryRules.targetSellTaxBps(11e17, 1e18, b, m, d), 300); // above peg
        assertEq(MasonryRules.targetSellTaxBps(1e18, 1e18, b, m, d), 300); // at peg
        assertEq(MasonryRules.targetSellTaxBps(98e16, 1e18, b, m, d), 702); // 2% below
        assertEq(MasonryRules.targetSellTaxBps(95e16, 1e18, b, m, d), 936); // 5% below
        assertEq(MasonryRules.targetSellTaxBps(90e16, 1e18, b, m, d), 1200); // 10% below
        assertEq(MasonryRules.targetSellTaxBps(1, 1e18, b, m, d), 1200);
    }

    function test_ThreePercentFloorRecoveryDecaysOverSevenHours() public pure {
        uint16 b = MasonryRules.DEFAULT_BASE_FIRE_TAX_BPS;
        uint256 start = 100_000;
        assertEq(MasonryRules.recoveryFloorBps(1200, b, start, start), 1200);
        assertEq(MasonryRules.recoveryFloorBps(1200, b, start, start + 3.5 hours), 750);
        assertEq(MasonryRules.recoveryFloorBps(1200, b, start, start + 7 hours - 1), 300);
        assertEq(MasonryRules.recoveryFloorBps(1200, b, start, start + 7 hours), 300);
        assertEq(MasonryRules.recoveryFloorBps(1200, b, start, start + 30 days), 300);
    }

    function testFuzz_ThreePercentFloorBounds(uint128 price) public pure {
        uint16 tax = MasonryRules.targetSellTaxBps(price, 1e18, 300, 1200, 1000);
        assertGe(tax, 300);
        assertLe(tax, 1200);
    }

    function test_SevenHourTaxRecovery() public pure {
        uint256 start = 100_000;
        assertEq(MasonryRules.recoveryFloorBps(1200, 100, start, start), 1200);
        assertEq(MasonryRules.recoveryFloorBps(1200, 100, start, start + 3.5 hours), 650);
        assertEq(MasonryRules.recoveryFloorBps(1200, 100, start, start + 7 hours), 100);
    }

    function test_WithdrawFeeMatchesFireTaxAtPegTenPercentAndDecay() public pure {
        uint256 peg = 1e18;
        uint16 b = 300;
        uint16 m = 1200;
        uint16 d = 1000;
        uint256 t0 = 1_000_000;
        assertEq(MasonryRules.withdrawFeeBps(peg, peg, b, m, d, b, t0, t0), 300);
        assertEq(MasonryRules.withdrawFeeBps(90e16, peg, b, m, d, b, t0, t0), 1200);
        assertEq(MasonryRules.withdrawFeeBps(70e16, peg, b, m, d, b, t0, t0), 1200);
        assertEq(MasonryRules.withdrawFeeBps(peg, peg, b, m, d, 1200, t0, t0), 1200);
        assertEq(MasonryRules.withdrawFeeBps(peg, peg, b, m, d, 1200, t0, t0 + 3.5 hours), 750);
        assertEq(MasonryRules.withdrawFeeBps(peg, peg, b, m, d, 1200, t0, t0 + 7 hours), 300);
    }

    function testFuzz_WithdrawFeeNeverExceedsTwelvePercent(uint128 price, uint32 elapsed) public pure {
        uint16 fee = MasonryRules.withdrawFeeBps(price == 0 ? 1 : uint256(price), 1e18, 300, 1200, 1000, 1200, 0, elapsed);
        assertGe(fee, 300);
        assertLe(fee, 1200);
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

    function testFuzz_FireTaxNeverExceedsTwelvePercent(
        uint128 price
    ) public pure {
        uint16 tax = MasonryRules.targetSellTaxBps(uint256(price), 1e18, 100, 1200, 1000);
        assertGe(tax, 100);
        assertLe(tax, 1200);
    }

    function testFuzz_RecoveryNeverExceedsTwelvePercent(
        uint32 elapsed
    ) public pure {
        uint16 tax = MasonryRules.recoveryFloorBps(1200, 100, 100, 100 + uint256(elapsed));
        assertGe(tax, 100);
        assertLe(tax, 1200);
    }

    function validateSquareAllocations(
        uint256[4] memory vested
    ) external pure {
        MasonryRules.validateSquareAllocations(33_333, 25_641, 100, 1, 100, 500, 50, vested);
    }

    function targetSellTaxBps(
        uint16 maximumBps
    ) external pure {
        MasonryRules.targetSellTaxBps(90e16, 1e18, 100, maximumBps, 1000);
    }

    function expansionUpperBound(
        uint16 requestedRateBps
    ) external pure {
        MasonryRules.expansionUpperBound(100_000e18, requestedRateBps, 102e16, 1e18, true);
    }
}
