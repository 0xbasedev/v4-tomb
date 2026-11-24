// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/**
 * @title ITreasury
 * @notice The slice of the Treasury the Masonry and peripheral contracts read: the epoch
 *         clock and the peg token's TWAP.
 */
interface ITreasury {
    function epoch() external view returns (uint256);
    function nextEpochPoint() external view returns (uint256);
    function getPegPrice() external view returns (uint256);
}
