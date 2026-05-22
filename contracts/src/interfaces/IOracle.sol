// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/**
 * @title IOracle
 * @notice Exact interface match for Tomb Finance's IOracle. Treasury and Boardroom call
 *         `consult(token, amountIn)` to get a TWAP-denominated quote.
 */
interface IOracle {
    /// @notice Snapshot the cumulative price into a new period-windowed TWAP. Permissionless
    ///         once the period has elapsed; trustees-only before that.
    function update() external;

    /// @notice Quote `amountIn` of `token` against the last completed period's TWAP.
    /// @dev Returns 0 until the first successful `update()` call.
    function consult(
        address token,
        uint256 amountIn
    ) external view returns (uint144 amountOut);

    /// @notice Quote `amountIn` of `token` against the current up-to-the-minute TWAP
    ///         (recomputes from current cumulatives without modifying state).
    function twap(
        address token,
        uint256 amountIn
    ) external view returns (uint144 amountOut);
}
