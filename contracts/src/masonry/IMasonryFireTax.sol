// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Live Fire Tax rate used as the liquidity withdraw fee (TWAP + 7h recovery).
interface IMasonryFireTax {
    function currentWithdrawFeeBps() external view returns (uint16);
    function syncWithdrawFeeBps() external returns (uint16);
}
