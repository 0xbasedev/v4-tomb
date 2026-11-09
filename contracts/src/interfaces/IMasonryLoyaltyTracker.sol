// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/**
 * @title IMasonryLoyaltyTracker
 * @notice Callback the Boardroom (the Masonry) fires on every stake change so
 *         the weekly loyalty boost (ShareRewardPool) can observe Masonry
 *         stake and — critically — Masonry LP withdrawals, which no balance
 *         read can reconstruct after the fact. Called after the Boardroom's
 *         own state has moved; `amount` is the size of the change, so the
 *         tracker can rebuild the pre-change position exactly.
 */
interface IMasonryLoyaltyTracker {
    function onMasonryStakeChange(
        address user,
        bool isWithdrawal,
        uint256 amount
    ) external;
}
