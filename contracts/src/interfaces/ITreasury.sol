// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/**
 * @title ITreasury
 * @notice Tomb-shape interface for the Treasury contract. Boardroom and any peripheral
 *         contracts call into this for epoch / price / bond data.
 */
interface ITreasury {
    function epoch() external view returns (uint256);
    function nextEpochPoint() external view returns (uint256);
    function getMoneyPrice() external view returns (uint256);

    function buyBonds(
        uint256 amount,
        uint256 targetPrice
    ) external;
    function redeemBonds(
        uint256 amount,
        uint256 targetPrice
    ) external;
}
