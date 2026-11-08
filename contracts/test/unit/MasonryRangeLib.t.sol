// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {MasonryRangeLib} from "../../src/masonry/MasonryRangeLib.sol";

contract MasonryRangeLibTest is Test {
    function checkConfig(
        uint16 halfWidthBps,
        uint16 recenterBps,
        uint256 cooldown,
        uint16 maxTwapDeviationBps
    ) external pure {
        MasonryRangeLib.validate(halfWidthBps, recenterBps, cooldown, maxTwapDeviationBps);
    }

    function testValidateRejectsOutOfBounds() public {
        vm.expectRevert(MasonryRangeLib.InvalidRangeConfig.selector);
        this.checkConfig(400, 200, 1800, 300);
        vm.expectRevert(MasonryRangeLib.InvalidRangeConfig.selector);
        this.checkConfig(1500, 1500, 1800, 300);
        vm.expectRevert(MasonryRangeLib.InvalidRangeConfig.selector);
        this.checkConfig(1500, 50, 1800, 300);
        vm.expectRevert(MasonryRangeLib.InvalidRangeConfig.selector);
        this.checkConfig(1500, 1000, 10, 300);
        vm.expectRevert(MasonryRangeLib.InvalidRangeConfig.selector);
        this.checkConfig(1500, 1000, 2 days, 300);
        vm.expectRevert(MasonryRangeLib.InvalidRangeConfig.selector);
        this.checkConfig(1500, 1000, 1800, 0);
        vm.expectRevert(MasonryRangeLib.InvalidRangeConfig.selector);
        this.checkConfig(1500, 1000, 1800, 1001);
    }

    function testValidateAcceptsDefaults() public pure {
        MasonryRangeLib.validate(1500, 1000, 1800, 300);
    }

    function testBandTicksAreSpacingAlignedAndContainSpot() public pure {
        uint160 peg = uint160((uint256(1) << 96) / 1e6);
        (int24 lower, int24 upper) = MasonryRangeLib.bandTicks(peg, 1500, 60);
        assertEq(lower % 60, 0);
        assertEq(upper % 60, 0);
        int24 tick = TickMath.getTickAtSqrtPrice(peg);
        assertLt(lower, tick);
        assertGt(upper, tick);
        uint256 width = uint256(int256(upper - lower));
        assertGt(width, 2000);
        assertLt(width, 4000);
    }

    function testNeedsRecenterInnerBandAndOutOfRange() public pure {
        int24 lower = -1500;
        int24 upper = 1500;
        assertFalse(MasonryRangeLib.needsRecenter(0, lower, upper, 1500, 1000));
        assertTrue(MasonryRangeLib.needsRecenter(1100, lower, upper, 1500, 1000));
        assertTrue(MasonryRangeLib.needsRecenter(-1100, lower, upper, 1500, 1000));
        assertTrue(MasonryRangeLib.needsRecenter(-1500, lower, upper, 1500, 1000));
        assertTrue(MasonryRangeLib.needsRecenter(1600, lower, upper, 1500, 1000));
    }

    function testDeviationBps() public pure {
        assertEq(MasonryRangeLib.deviationBps(1.03e18, 1e18), 300);
        assertEq(MasonryRangeLib.deviationBps(0.97e18, 1e18), 300);
        assertGt(MasonryRangeLib.deviationBps(1.05e18, 1e18), 300);
        assertEq(MasonryRangeLib.deviationBps(0, 0), type(uint256).max);
    }

    function testSqrtPriceLimitAndValueLoss() public pure {
        uint160 peg = uint160(1 << 96);
        uint160 down = MasonryRangeLib.sqrtPriceLimit(peg, 300, true);
        uint160 up = MasonryRangeLib.sqrtPriceLimit(peg, 300, false);
        assertLt(down, peg);
        assertGt(up, peg);
        assertFalse(MasonryRangeLib.exceedsLoss(1e18, 1e18 - 1e18 * 50 / 10_000, 100));
        assertTrue(MasonryRangeLib.exceedsLoss(1e18, 1e18 - 1e18 * 200 / 10_000, 100));
    }
}

