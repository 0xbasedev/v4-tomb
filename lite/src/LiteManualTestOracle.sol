// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ILitePriceSource} from "./XTombLite.sol";

/// @notice UNSAFE TEST ORACLE: MANUALLY SET PRICES, NO TWAP. LONGYU testnet only.
/// @dev Always replace with a verified on-chain TWAP before public deposits,
///      any real USD-denominated fee collection, or production deployment.
contract LiteManualTestOracle is ILitePriceSource {
    address public immutable owner;
    uint256 public priceE18;
    uint256 public updatedAt;

    error Unauthorized();
    error TestnetOnly();

    constructor(address owner_) {
        if (block.chainid != 668801) revert TestnetOnly();
        require(owner_ != address(0), "zero owner");
        owner = owner_;
    }

    function setTestPrice(uint256 price_) external {
        if (msg.sender != owner) revert Unauthorized();
        priceE18 = price_;
        updatedAt = block.timestamp;
    }

    function latestPrice() external view returns (uint256, uint256) {
        return (priceE18, updatedAt);
    }
}
