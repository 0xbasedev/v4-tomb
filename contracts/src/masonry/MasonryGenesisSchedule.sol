// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Shared immutable clock for Genesis staking and LEVEL tax routing.
contract MasonryGenesisSchedule {
    uint256 public constant DURATION = 7 days;
    uint256 public constant LP_DELAY = 1 days;

    uint256 public immutable start;
    uint256 public immutable lpOpens;
    uint256 public immutable end;

    error InvalidStart();

    constructor(
        uint256 start_
    ) {
        if (start_ <= block.timestamp) revert InvalidStart();
        start = start_;
        lpOpens = start_ + LP_DELAY;
        end = start_ + DURATION;
    }

    function active() public view returns (bool) {
        return block.timestamp >= start && block.timestamp < end;
    }

    function lpOpen() external view returns (bool) {
        return block.timestamp >= lpOpens && block.timestamp < end;
    }
}
