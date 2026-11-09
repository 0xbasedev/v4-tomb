// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {MasonryUsdcVault} from "./MasonryLevelUsdcVault.sol";
import {MasonryBuybackGuard} from "./MasonryBuybackGuard.sol";
import {MasonryCriticalDefense} from "./MasonryCriticalDefense.sol";
import {MasonryGenesisSchedule} from "./MasonryGenesisSchedule.sol";
import {MiniSwapRouter} from "../swap/MiniSwapRouter.sol";

/// @notice Auto-range SQUARE/USDC vault for Treasury-owned POL shares.
/// TWAP-centered (never spot) and not Genesis-gated: this pool is the
/// Masonry/farm pool, so rebalancing may run whenever the pool is live
/// and every other guard passes (auto-range design 2026-11-08 §4.5).
contract MasonrySquareUsdcVault is MasonryUsdcVault {
    constructor(
        PoolKey memory pool,
        int24 lower,
        int24 upper,
        MasonryBuybackGuard guard_,
        MiniSwapRouter router_,
        MasonryCriticalDefense defense_,
        address owner_
    )
        MasonryUsdcVault(
            pool,
            lower,
            upper,
            "Masonry SQUARE/USDC LP",
            "mSQUARE-USDC",
            guard_,
            router_,
            defense_,
            MasonryGenesisSchedule(address(0)),
            false,
            1800,
            1000,
            owner_
        )
    {}

    function depositFromHook(
        uint256 maxSquare,
        uint256 maxUsdc,
        address recipient
    ) external nonReentrant returns (uint256 shares, uint256 squareIn, uint256 usdcIn) {
        return _depositBalancedFromHook(maxSquare, maxUsdc, recipient);
    }
}
