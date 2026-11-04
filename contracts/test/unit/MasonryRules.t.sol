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
        assertEq(MasonryRules.targetSellTaxBps(1e18, 1e18, 100, 1200, 1500), 100);
        assertEq(MasonryRules.targetSellTaxBps(12e17, 1e18, 100, 1200, 1500), 100);
    }

    function test_TaxAtOrBelowEightyFiveCentsIsTwelvePercent() public pure {
        assertEq(MasonryRules.targetSellTaxBps(85e16, 1e18, 100, 1200, 1500), 1200);
        assertEq(MasonryRules.targetSellTaxBps(70e16, 1e18, 100, 1200, 1500), 1200);
    }

    function test_QuadraticCurveAtHalfway() public pure {
        assertEq(MasonryRules.targetSellTaxBps(925e15, 1e18, 100, 1200, 1500), 375);
    }

    function test_FireTaxHardCapRejectsHigherValue() public {
        vm.expectRevert(MasonryRules.InvalidParameters.selector);
        this.targetSellTaxBps(1201);
    }

    function test_ProjectedSellRaisesTaxOnSameTrade() public pure {
        uint16 twap = MasonryRules.targetSellTaxBps(1e18, 1e18, 100, 1200, 1500);
        uint16 projected = MasonryRules.targetSellTaxBps(85e16, 1e18, 100, 1200, 1500);
        assertEq(MasonryRules.effectiveSellTaxBps(twap, projected, 100), 1200);
    }

    function test_SevenHourTaxRecovery() public pure {
        uint256 start = 100_000;
        assertEq(MasonryRules.recoveryFloorBps(1200, 100, start, start), 1200);
        assertEq(MasonryRules.recoveryFloorBps(1200, 100, start, start + 3.5 hours), 650);
        assertEq(MasonryRules.recoveryFloorBps(1200, 100, start, start + 7 hours), 100);
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
        uint16 tax = MasonryRules.targetSellTaxBps(uint256(price), 1e18, 100, 1200, 1500);
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
        MasonryRules.targetSellTaxBps(90e16, 1e18, 100, maximumBps, 1500);
    }

    function expansionUpperBound(
        uint16 requestedRateBps
    ) external pure {
        MasonryRules.expansionUpperBound(100_000e18, requestedRateBps, 102e16, 1e18, true);
    }
}
