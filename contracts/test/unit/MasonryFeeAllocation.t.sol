// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MasonryFeeAllocation} from "../../src/masonry/MasonryFeeAllocation.sol";

contract MasonryFeeAllocationTest is Test {
    function test_DefaultSquareSplitExact() public pure {
        MasonryFeeAllocation.SquareTax memory a = MasonryFeeAllocation.allocateSquare(100e18, false);
        assertEq(a.polSquare, 12e18);
        assertEq(a.usdcReserveSquare, 20e18);
        assertEq(a.retainedSquare, 68e18);
        assertEq(a.buyAndBurnSquare, 0);
    }

    function test_CriticalModeRoutesAllNewFeeRevenueToBurn() public pure {
        MasonryFeeAllocation.SquareTax memory a = MasonryFeeAllocation.allocateSquare(100e18, true);
        assertEq(a.polSquare, 0);
        assertEq(a.usdcReserveSquare, 0);
        assertEq(a.retainedSquare, 0);
        assertEq(a.buyAndBurnSquare, 100e18);
    }

    function testFuzz_AllocationNeverLosesOrMintsWei(
        uint128 amount,
        bool critical
    ) public pure {
        MasonryFeeAllocation.SquareTax memory a = MasonryFeeAllocation.allocateSquare(uint256(amount), critical);
        assertEq(a.polSquare + a.usdcReserveSquare + a.retainedSquare + a.buyAndBurnSquare, uint256(amount));
        if (critical) assertEq(a.buyAndBurnSquare, uint256(amount));
        else assertEq(a.buyAndBurnSquare, 0);
    }

    function test_CollectionTimeEarmarkDoesNotChangeWhenRegimeChanges() public pure {
        MasonryFeeAllocation.SquareTax memory normal = MasonryFeeAllocation.allocateSquare(100e18, false);
        MasonryFeeAllocation.SquareTax memory later = MasonryFeeAllocation.allocateSquare(100e18, true);
        assertEq(normal.polSquare, 12e18);
        assertEq(normal.usdcReserveSquare, 20e18);
        assertEq(normal.retainedSquare, 68e18);
        assertEq(later.buyAndBurnSquare, 100e18);
    }
}
