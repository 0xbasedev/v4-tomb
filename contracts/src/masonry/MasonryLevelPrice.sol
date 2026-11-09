// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";

/// @notice Normalizes the official pool's 18-decimal LEVEL and 6-decimal USDC.
library MasonryLevelPrice {
    uint256 private constant Q96 = 1 << 96;
    uint256 private constant Q192 = 1 << 192;

    function fromSqrtPrice(
        uint160 sqrtPrice,
        bool levelIsCurrency0
    ) internal pure returns (uint256) {
        if (levelIsCurrency0) {
            return FullMath.mulDiv(FullMath.mulDiv(sqrtPrice, sqrtPrice, Q96), 1e30, Q96);
        }
        return FullMath.mulDiv(FullMath.mulDiv(Q96, 1e30, sqrtPrice), Q96, sqrtPrice);
    }

    /// @notice Exact inverse of fromSqrtPrice: the sqrt price whose normalized
    /// price equals the given 1e18-scale price (USDC per asset).
    function sqrtPriceFromPrice(
        uint256 price,
        bool levelIsCurrency0
    ) internal pure returns (uint160) {
        uint256 squared;
        if (levelIsCurrency0) {
            // price = sqrtPrice^2 * 1e30 / 2^192  =>  sqrtPrice^2 = price * 2^192 / 1e30
            squared = FullMath.mulDiv(price, Q192, 1e30);
        } else {
            // price = 2^192 * 1e30 / sqrtPrice^2  =>  sqrtPrice^2 = 1e30 * 2^192 / price
            squared = FullMath.mulDiv(1e30, Q192, price);
        }
        return uint160(Math.sqrt(squared));
    }

    /// @notice Tick corresponding to a 1e18-scale TWAP/peg price. This is the
    /// only price-to-tick conversion the auto-range vault may use; it is fed
    /// exclusively with validated TWAP or the configured peg, never spot.
    function tickFromPrice(
        uint256 price,
        bool levelIsCurrency0
    ) internal pure returns (int24) {
        return TickMath.getTickAtSqrtPrice(sqrtPriceFromPrice(price, levelIsCurrency0));
    }
}
