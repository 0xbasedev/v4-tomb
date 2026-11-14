// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Collection-time allocation of collected SQUARE Fire Tax.
/// Never applies to already earmarked balances, LEVEL fees, user balances,
/// Genesis LP burn fees, or bot principal.
///
/// During regular operation: 12% SQUARE/USDC POL, 20% USDC reserve
/// (funded by selling collected SQUARE only), 68% held as native SQUARE.
/// During Critical Defense: 100% eligible newly collected SQUARE tax
/// becomes reserved for LEVEL buyback/burn through SQUARE->USDC->LEVEL.
/// Later TWAP changes do not retroactively change collection earmarks.
library MasonryFeeAllocation {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant POL_BPS = 1200;
    uint256 internal constant USDC_RESERVE_BPS = 2000;

    struct SquareTax {
        uint256 polSquare;
        uint256 usdcReserveSquare;
        uint256 retainedSquare;
        uint256 buyAndBurnSquare;
    }

    function allocateSquare(
        uint256 amount,
        bool criticalDefense
    ) internal pure returns (SquareTax memory a) {
        if (criticalDefense) {
            a.buyAndBurnSquare = amount;
            return a;
        }
        a.polSquare = Math.mulDiv(amount, POL_BPS, BPS);
        a.usdcReserveSquare = Math.mulDiv(amount, USDC_RESERVE_BPS, BPS);
        // Send only division dust to the native SQUARE inventory: conserve every wei.
        a.retainedSquare = amount - a.polSquare - a.usdcReserveSquare;
    }
}
