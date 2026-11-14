// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";

/// @notice SquareHook POL destination: fixed vault or protocol-owned range manager.
interface IMasonryPolSink {
    function poolKey() external view returns (PoolKey memory);
    function manager() external view returns (IPoolManager);
    function tickLower() external view returns (int24);
    function tickUpper() external view returns (int24);
    function depositFromHook(
        uint256 maxAsset,
        uint256 maxQuote,
        address recipient
    ) external returns (uint256 shares, uint256 assetIn, uint256 quoteIn);
}

/// @notice Optional afterSwap recentering target. Must never revert a user swap.
interface IMasonryRangeNudge {
    function nudge() external;
    function hook() external view returns (address);
}
