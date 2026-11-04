// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {MasonryUsdcVault} from "./MasonryLevelUsdcVault.sol";

/// @notice Fixed-range SQUARE/USDC vault for Treasury-owned POL shares.
contract MasonrySquareUsdcVault is MasonryUsdcVault {
    constructor(
        PoolKey memory pool,
        int24 lower,
        int24 upper
    ) MasonryUsdcVault(pool, lower, upper, "Masonry SQUARE/USDC LP", "mSQUARE-USDC") {}

    function depositFromHook(
        uint256 maxSquare,
        uint256 maxUsdc,
        address recipient
    ) external nonReentrant returns (uint256 shares, uint256 squareIn, uint256 usdcIn) {
        return _depositBalancedFromHook(maxSquare, maxUsdc, recipient);
    }
}
