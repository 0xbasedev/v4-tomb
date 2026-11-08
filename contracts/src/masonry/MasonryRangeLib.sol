// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Tick-band math and bounds for protocol-owned concentrated ranges.
library MasonryRangeLib {
    uint16 internal constant MIN_HALF_WIDTH_BPS = 500;
    uint16 internal constant MAX_HALF_WIDTH_BPS = 3000;
    uint16 internal constant MIN_RECENTER_BPS = 100;
    uint256 internal constant MIN_COOLDOWN = 60;
    uint256 internal constant MAX_COOLDOWN = 1 days;
    uint16 internal constant MIN_TWAP_DEV_BPS = 1;
    uint16 internal constant MAX_TWAP_DEV_BPS = 1000;
    uint256 internal constant BPS = 10_000;

    error InvalidRangeConfig();

    function validate(
        uint16 halfWidthBps,
        uint16 recenterBps,
        uint256 cooldown,
        uint16 maxTwapDeviationBps
    ) internal pure {
        if (
            halfWidthBps < MIN_HALF_WIDTH_BPS || halfWidthBps > MAX_HALF_WIDTH_BPS || recenterBps < MIN_RECENTER_BPS
                || recenterBps >= halfWidthBps || cooldown < MIN_COOLDOWN || cooldown > MAX_COOLDOWN
                || maxTwapDeviationBps < MIN_TWAP_DEV_BPS || maxTwapDeviationBps > MAX_TWAP_DEV_BPS
        ) revert InvalidRangeConfig();
    }

    function align(
        int24 tick,
        int24 spacing,
        bool roundUp
    ) internal pure returns (int24) {
        int24 compressed = tick / spacing;
        if (tick < 0 && tick % spacing != 0) compressed--;
        if (roundUp && compressed * spacing < tick) compressed++;
        return compressed * spacing;
    }

    /// @notice Width-aligned ticks around `sqrtPrice` (± halfWidthBps of price).
    function bandTicks(
        uint160 sqrtPrice,
        uint16 halfWidthBps,
        int24 spacing
    ) internal pure returns (int24 lower, int24 upper) {
        uint256 scale = Math.sqrt(BPS * 1e12);
        uint256 lowerSqrt = FullMath.mulDiv(sqrtPrice, Math.sqrt((BPS - halfWidthBps) * 1e12), scale);
        uint256 upperSqrt = FullMath.mulDiv(sqrtPrice, Math.sqrt((BPS + halfWidthBps) * 1e12), scale);
        if (lowerSqrt < TickMath.MIN_SQRT_PRICE) lowerSqrt = TickMath.MIN_SQRT_PRICE;
        if (upperSqrt >= TickMath.MAX_SQRT_PRICE) upperSqrt = uint256(TickMath.MAX_SQRT_PRICE) - 1;
        lower = align(TickMath.getTickAtSqrtPrice(uint160(lowerSqrt)), spacing, false);
        upper = align(TickMath.getTickAtSqrtPrice(uint160(upperSqrt)), spacing, true);
        if (lower >= upper) {
            lower = align(TickMath.getTickAtSqrtPrice(sqrtPrice) - spacing, spacing, false);
            upper = lower + spacing;
        }
        if (lower < TickMath.MIN_TICK) lower = align(TickMath.MIN_TICK, spacing, true);
        if (upper > TickMath.MAX_TICK) upper = align(TickMath.MAX_TICK, spacing, false);
        if (lower >= upper) revert InvalidRangeConfig();
    }

    /// @notice Recenter when the tick is outside the position or outside the inner band.
    function needsRecenter(
        int24 tick,
        int24 lower,
        int24 upper,
        uint16 halfWidthBps,
        uint16 recenterBps
    ) internal pure returns (bool) {
        if (lower >= upper) return true;
        if (tick <= lower || tick >= upper) return true;
        int24 mid = int24((int256(lower) + int256(upper)) / 2);
        int24 half = (upper - lower) / 2;
        int24 inner = int24(int256(uint256(uint24(half)) * uint256(recenterBps) / uint256(halfWidthBps)));
        if (inner == 0) inner = 1;
        int24 dist = tick > mid ? tick - mid : mid - tick;
        return dist >= inner;
    }

    function deviationBps(
        uint256 spot,
        uint256 twap
    ) internal pure returns (uint256) {
        if (twap == 0) return type(uint256).max;
        uint256 diff = spot > twap ? spot - twap : twap - spot;
        return FullMath.mulDiv(diff, BPS, twap);
    }
}
