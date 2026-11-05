// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "v4-core/src/libraries/FullMath.sol";

/// @notice Normalizes the official pool's 18-decimal LEVEL and 6-decimal USDC.
library MasonryLevelPrice {
    uint256 private constant Q96 = 1 << 96;

    function fromSqrtPrice(
        uint160 sqrtPrice,
        bool levelIsCurrency0
    ) internal pure returns (uint256) {
        if (levelIsCurrency0) {
            return FullMath.mulDiv(FullMath.mulDiv(sqrtPrice, sqrtPrice, Q96), 1e30, Q96);
        }
        return FullMath.mulDiv(FullMath.mulDiv(Q96, 1e30, sqrtPrice), Q96, sqrtPrice);
    }
}
