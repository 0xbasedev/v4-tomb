// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IMasonryFireTax} from "../../src/masonry/IMasonryFireTax.sol";

contract MockFireTax is IMasonryFireTax {
    uint16 public rate = 300;

    function set(uint16 r) external {
        rate = r;
    }

    function currentWithdrawFeeBps() external view returns (uint16) {
        return rate;
    }

    function syncWithdrawFeeBps() external returns (uint16) {
        return rate;
    }
}
