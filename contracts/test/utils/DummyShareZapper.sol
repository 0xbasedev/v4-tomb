// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Placeholder zapper so Farm can be constructed in tests that do not exercise zaps.
contract DummyShareZapper {
    function zap(address, uint256, uint256, uint256) external pure returns (uint256, uint256, uint256) {
        return (0, 0, 0);
    }

    function lpToken() external pure returns (address) {
        return address(0);
    }
}
