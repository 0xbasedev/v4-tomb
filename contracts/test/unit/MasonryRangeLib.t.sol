// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {MasonryRangeLib} from "../../src/masonry/MasonryRangeLib.sol";
import {MasonryLevelPrice} from "../../src/masonry/MasonryLevelPrice.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

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
        MasonryRangeLib.validate(2000, 1600, 1800, 300);
        MasonryRangeLib.validate(800, 640, 1800, 300);
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

    function testFixedAndFollowAndPegAnchorBaselinesAtDepeg() public pure {
        // asset-as-token0 peg sqrt used by the official xTOMB/USDG tests
        uint160 peg = uint160((uint256(1) << 96) / 1e6);
        // ~18% below peg in asset price (pool sqrt rises by ~1/sqrt(0.82))
        uint160 spot = uint160(uint256(peg) * 110432 / 100000);
        int24 pegTick = TickMath.getTickAtSqrtPrice(peg);
        int24 spotTick = TickMath.getTickAtSqrtPrice(spot);
        assertTrue(spotTick != pegTick);

        (int24 followL, int24 followU) = MasonryRangeLib.bandTicks(spot, 1500, 60);
        (int24 fixedL, int24 fixedU) = MasonryRangeLib.fixedPegTicks(peg, 1500, 60);
        (int24 anchorL, int24 anchorU) = MasonryRangeLib.pegAnchorTicks(spot, peg, 1500, 1500, 60);

        assertTrue(MasonryRangeLib.containsTick(spotTick, followL, followU));
        assertFalse(MasonryRangeLib.containsTick(pegTick, followL, followU), "follow around a depeg abandons $1");

        assertTrue(MasonryRangeLib.containsTick(pegTick, fixedL, fixedU), "fixed book stays on $1");
        assertFalse(MasonryRangeLib.containsTick(spotTick, fixedL, fixedU), "tight fixed book is idle below its lower edge");

        assertTrue(MasonryRangeLib.containsTick(spotTick, anchorL, anchorU));
        assertTrue(MasonryRangeLib.containsTick(pegTick, anchorL, anchorU), "peg-anchor keeps the recovery path");
        (int24 expectedFixedL,) = MasonryRangeLib.bandTicks(peg, 1500, 60);
        assertEq(fixedL, expectedFixedL);
    }

    /// @dev Price-space high edge of peg-anchor (-18% / +10%) stays at or
    /// above $1 when spot is $0.70 or $0.80, for both token orderings.
    /// (Tick-upper is the cheap side when the level token is currency1.)
    function testPegAnchorUpperEdgeStaysAtOrAbovePegOnDeepDepeg() public pure {
        _assertPegAnchorHighEdge(70e16, true);
        _assertPegAnchorHighEdge(70e16, false);
        _assertPegAnchorHighEdge(80e16, true);
        _assertPegAnchorHighEdge(80e16, false);
    }

    function _assertPegAnchorHighEdge(uint256 spotPriceWad, bool levelIsCurrency0) private pure {
        uint160 peg = levelIsCurrency0 ? uint160((uint256(1) << 96) / 1e6) : uint160((uint256(1) << 96) * 1e6);
        assertApproxEqAbs(MasonryLevelPrice.fromSqrtPrice(peg, levelIsCurrency0), 1e18, 10);

        uint256 ratioSqrtWad = Math.sqrt(spotPriceWad * 1e18);
        uint160 spot = levelIsCurrency0
            ? uint160(uint256(peg) * ratioSqrtWad / 1e18)
            : uint160(uint256(peg) * 1e18 / ratioSqrtWad);

        uint256 reconstructed = MasonryLevelPrice.fromSqrtPrice(spot, levelIsCurrency0);
        // Allow a few wei of rounding from the integer square root.
        if (reconstructed > spotPriceWad) {
            assertLe(reconstructed - spotPriceWad, 1e10);
        } else {
            assertLe(spotPriceWad - reconstructed, 1e10);
        }

        (int24 lower, int24 upper) = MasonryRangeLib.pegAnchorTicks(spot, peg, 1800, 1000, 60);
        uint256 priceLower = MasonryLevelPrice.fromSqrtPrice(TickMath.getSqrtPriceAtTick(lower), levelIsCurrency0);
        uint256 priceUpper = MasonryLevelPrice.fromSqrtPrice(TickMath.getSqrtPriceAtTick(upper), levelIsCurrency0);
        uint256 highEdge = priceLower > priceUpper ? priceLower : priceUpper;
        int24 pegTick = TickMath.getTickAtSqrtPrice(peg);
        int24 spotTick = TickMath.getTickAtSqrtPrice(spot);

        assertTrue(MasonryRangeLib.containsTick(pegTick, lower, upper), "recovery path through $1");
        assertTrue(MasonryRangeLib.containsTick(spotTick, lower, upper), "spot stays inside the book");
        assertGe(highEdge, 1e18, "price-space upper edge stays at or above $1");
    }
}
