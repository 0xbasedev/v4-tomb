// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IOracle} from "../../src/interfaces/IOracle.sol";

/// @notice Test-only IOracle that returns a settable price. Treasury reads
///         `consult(money, 1e18)` → expected return is the MONEY/WETH ratio scaled to 1e18.
contract MockOracle is IOracle {
    uint256 public price;
    uint256 public updateCount;
    bool public fresh = true;

    constructor(
        uint256 initialPrice
    ) {
        price = initialPrice;
    }

    function setPrice(
        uint256 newPrice
    ) external {
        price = newPrice;
    }

    function setFresh(bool value) external {
        fresh = value;
    }

    function isFresh(uint256) external view returns (bool) {
        return fresh;
    }

    function update() external {
        unchecked {
            ++updateCount;
        }
    }

    function consult(
        address,
        uint256 amountIn
    ) external view returns (uint144) {
        return uint144(price * amountIn / 1e18);
    }

    function twap(
        address,
        uint256 amountIn
    ) external view returns (uint144) {
        return uint144(price * amountIn / 1e18);
    }
}
