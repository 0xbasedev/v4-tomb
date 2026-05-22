// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Trustees} from "../governance/Trustees.sol";

/**
 * @title Epoch
 * @notice Period-windowed epoch counter. Shared base for the Oracle, Treasury, and any other
 *         contract whose work is batched into fixed-length time windows.
 * @dev    Direct port of Tomb Finance's utils/Epoch.sol with one substitution: inherits
 *         [[Trustees]] instead of `Operator` so the access pattern matches the rest of Old
 *         Money. The `checkEpoch` modifier's "pre-epoch privilege" is granted to trustees
 *         (== Tomb's operator) — exact same semantics.
 *
 *         Epoch semantics (matches Tomb):
 *         - Trustees can call epoch-gated functions BEFORE the next epoch point — the call
 *           runs but `epoch` does not advance.
 *         - Once `block.timestamp >= nextEpochPoint()`, anyone can call the gated function;
 *           epoch advances by one, and the loop catches up across multiple skipped periods.
 *         - `_lastEpochTime` is initialized to `startTime - period` so the FIRST call's
 *           `nextEpochPoint()` equals `startTime`.
 */
abstract contract Epoch is Trustees {
    uint256 private _period;
    uint256 private _startTime;
    uint256 private _lastEpochTime;
    uint256 private _epoch;

    error NotStarted();
    error PreEpochNotTrustees();
    error PeriodOutOfRange();

    modifier checkStartTime() {
        if (block.timestamp < _startTime) revert NotStarted();
        _;
    }

    modifier checkEpoch() {
        uint256 next = nextEpochPoint();
        if (block.timestamp < next) {
            if (msg.sender != trustees()) revert PreEpochNotTrustees();
            _;
        } else {
            _;
            // Advance one or more epochs to catch up with the current timestamp.
            for (;;) {
                _lastEpochTime = next;
                ++_epoch;
                next = nextEpochPoint();
                if (block.timestamp < next) break;
            }
        }
    }

    constructor(
        uint256 period_,
        uint256 startTime_,
        uint256 startEpoch_
    ) {
        _period = period_;
        _startTime = startTime_;
        _epoch = startEpoch_;
        // Tomb's pattern: lastEpochTime = startTime - period so nextEpochPoint() == startTime.
        _lastEpochTime = startTime_ - period_;
    }

    function getCurrentEpoch() public view returns (uint256) {
        return _epoch;
    }

    function getPeriod() public view returns (uint256) {
        return _period;
    }

    function getStartTime() public view returns (uint256) {
        return _startTime;
    }

    function getLastEpochTime() public view returns (uint256) {
        return _lastEpochTime;
    }

    function nextEpochPoint() public view returns (uint256) {
        return _lastEpochTime + _period;
    }

    /// @notice Reset the epoch period. Trustees-only. Allowed range: [1 hour, 48 hours] — Tomb's bounds.
    function setPeriod(
        uint256 period_
    ) external onlyTrustees {
        if (period_ < 1 hours || period_ > 48 hours) revert PeriodOutOfRange();
        _period = period_;
    }

    /// @notice Force-set the epoch counter. Trustees-only.
    function setEpoch(
        uint256 epoch_
    ) external onlyTrustees {
        _epoch = epoch_;
    }
}
