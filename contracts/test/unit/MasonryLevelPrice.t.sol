// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {MasonryLevelPrice} from "../../src/masonry/MasonryLevelPrice.sol";

/// @notice Design §7 test 3: tick -> price -> tick round-trip must be the
/// identity within 1 tick, for both currency orders.
contract MasonryLevelPriceTest is Test {
    function testTickPriceRoundTripCurrency0() public pure {
        _roundTrip(true);
    }

    function testTickPriceRoundTripCurrency1() public pure {
        _roundTrip(false);
    }

    function testPegPriceMapsToPegTick() public pure {
        // $1.00 with an 18-decimal asset against 6-decimal USDC is sqrtPrice
        // 2^96 / 1e6 (asset is currency0) or 2^96 * 1e6 (asset is currency1).
        int24 tick0 = MasonryLevelPrice.tickFromPrice(1e18, true);
        int24 expected0 = TickMath.getTickAtSqrtPrice(uint160((uint256(1) << 96) / 1e6));
        assertEq(tick0, expected0);
        int24 tick1 = MasonryLevelPrice.tickFromPrice(1e18, false);
        int24 expected1 = TickMath.getTickAtSqrtPrice(uint160((uint256(1) << 96) * 1e6));
        assertEq(tick1, expected1);
    }

    function _roundTrip(
        bool assetIsCurrency0
    ) private pure {
        // Ticks spanning $0.10 to $10 around the $1 peg, in both directions.
        for (int24 tick = -23_000; tick <= 23_000; tick += 100) {
            uint160 sqrtPrice = TickMath.getSqrtPriceAtTick(tick);
            uint256 price = MasonryLevelPrice.fromSqrtPrice(sqrtPrice, assetIsCurrency0);
            int24 back = MasonryLevelPrice.tickFromPrice(price, assetIsCurrency0);
            int24 diff = back > tick ? back - tick : tick - back;
            assertTrue(diff <= 1, "round trip drifted more than 1 tick");
        }
    }
}
