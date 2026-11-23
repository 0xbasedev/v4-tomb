// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

interface ILiteChainlinkFeed {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @notice Reusable USD reference for native gas and fee tokens; not manually operator-set.
/// @dev Feed heartbeat and address must be selected by operator for the target network.
///      Rejects stale, zero, negative, incomplete and future-valued observations.
contract LiteChainlinkUsdSource {
    ILiteChainlinkFeed public immutable feed;
    uint8 public immutable feedDecimals;
    uint64 public immutable heartbeatSeconds;

    error InvalidFeed();
    error StaleFeed();

    constructor(address feed_, uint64 heartbeatSeconds_) {
        if (feed_.code.length == 0 || heartbeatSeconds_ == 0 || heartbeatSeconds_ > 1 hours) {
            revert InvalidFeed();
        }
        uint8 d = ILiteChainlinkFeed(feed_).decimals();
        if (d > 18) revert InvalidFeed();
        feed = ILiteChainlinkFeed(feed_);
        feedDecimals = d;
        heartbeatSeconds = heartbeatSeconds_;
    }

    function latestPrice() external view returns (uint256 priceE18, uint256 observedAt) {
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) =
            feed.latestRoundData();
        if (roundId == 0 || answeredInRound < roundId || answer <= 0 ||
            updatedAt == 0 || updatedAt > block.timestamp ||
            block.timestamp - updatedAt > heartbeatSeconds) revert StaleFeed();
        priceE18 = uint256(answer) * 10 ** (18 - feedDecimals);
        observedAt = updatedAt;
    }
}
