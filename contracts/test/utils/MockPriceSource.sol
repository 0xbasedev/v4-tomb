// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";

/// @notice Test-only IPriceSource. Holds a single (cumulative, timestamp) pair that tests
///         can advance directly to simulate swap-driven observation recording.
contract MockPriceSource is IPriceSource {
    int56 internal _cumulative;
    uint32 internal _timestamp;

    constructor(
        int56 cumulative_,
        uint32 timestamp_
    ) {
        _cumulative = cumulative_;
        _timestamp = timestamp_;
    }

    /// @notice Set the observation to an absolute (cumulative, timestamp). Tests use this
    ///         to set up specific scenarios.
    function setObservation(
        int56 cumulative_,
        uint32 timestamp_
    ) external {
        _cumulative = cumulative_;
        _timestamp = timestamp_;
    }

    /// @notice Advance the observation by `secondsElapsed` at a constant `tick`.
    ///         Mimics a real hook recording one observation per swap at a steady price.
    function advance(
        int24 tick,
        uint32 secondsElapsed
    ) external {
        unchecked {
            // tick * secondsElapsed fits easily in int56 since |tick| <= 887272 and
            // |secondsElapsed| <= 2^32, product fits in ~52 bits.
            _cumulative += int56(tick) * int56(uint56(secondsElapsed));
            _timestamp += secondsElapsed;
        }
    }

    function getCurrentTickCumulative() external view returns (int56, uint32) {
        return (_cumulative, _timestamp);
    }
}
