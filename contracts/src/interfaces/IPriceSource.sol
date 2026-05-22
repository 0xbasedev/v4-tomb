// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/**
 * @title IPriceSource
 * @notice Read interface for the Oracle's underlying tick-cumulative feed.
 * @dev    Conceptual analog of Uniswap V2's `pair.price0CumulativeLast()` — but instead of
 *         returning a raw uq112x112 cumulative price, it returns a tick cumulative (Uniswap
 *         V3/V4 convention). The consumer (Oracle) divides delta-cumulative by delta-time
 *         to recover the period-averaged tick, then converts that tick to a price via
 *         V4's TickMath.
 *
 *         In production, the PegDefenseHook (Sprint 4) implements this interface by
 *         recording observations on each swap through the OLDM/cbETH pool. For Sprint 2
 *         unit testing, a MockPriceSource lets us poke values in directly.
 */
interface IPriceSource {
    /// @notice The current tick cumulative and the timestamp at which it was recorded.
    /// @dev `cumulative` is the time-weighted sum of ticks since the source was initialized.
    ///       Delta-cumulative divided by delta-time over a window yields the average tick.
    function getCurrentTickCumulative() external view returns (int56 cumulative, uint32 blockTimestamp);
}
