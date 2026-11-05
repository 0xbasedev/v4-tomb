// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Shared clock for Genesis staking and LEVEL tax routing, fixed once scheduled.
contract MasonryGenesisSchedule {
    uint256 public constant DURATION = 7 days;
    uint256 public constant LP_DELAY = 1 days;

    address public immutable scheduler;
    uint256 public start;

    error InvalidStart();
    error Unauthorized();
    error AlreadyScheduled();

    event GenesisScheduled(uint256 start, uint256 lpOpens, uint256 end);

    constructor(
        uint256 start_,
        address scheduler_
    ) {
        if (scheduler_ == address(0)) revert Unauthorized();
        scheduler = scheduler_;
        if (start_ != 0) _schedule(start_);
    }

    function schedule(
        uint256 start_
    ) external {
        if (msg.sender != scheduler) revert Unauthorized();
        if (start != 0) revert AlreadyScheduled();
        _schedule(start_);
    }

    function _schedule(
        uint256 start_
    ) private {
        if (start_ <= block.timestamp || start_ > type(uint64).max - DURATION - 6 hours) revert InvalidStart();
        start = start_;
        emit GenesisScheduled(start_, lpOpens(), end());
    }

    function lpOpens() public view returns (uint256) {
        return start == 0 ? 0 : start + LP_DELAY;
    }

    function end() public view returns (uint256) {
        return start == 0 ? 0 : start + DURATION;
    }

    function active() public view returns (bool) {
        return start != 0 && block.timestamp >= start && block.timestamp < end();
    }

    function lpOpen() external view returns (bool) {
        return start != 0 && block.timestamp >= lpOpens() && block.timestamp < end();
    }
}
