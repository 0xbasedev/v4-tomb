// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice The destination-chain representation of xSHARE. The bridge alone can mint or burn it.
contract XTombBridgedShare is ERC20 {
    address public immutable bridge;

    error OnlyBridge();
    error InvalidBridge();

    constructor(
        address bridge_
    ) ERC20("Bridged xSHARE", "xSHARE") {
        if (bridge_ == address(0)) revert InvalidBridge();
        bridge = bridge_;
    }

    function bridgeMint(
        address recipient,
        uint256 amount
    ) external {
        if (msg.sender != bridge) revert OnlyBridge();
        _mint(recipient, amount);
    }

    function bridgeBurn(
        address sender,
        uint256 amount
    ) external {
        if (msg.sender != bridge) revert OnlyBridge();
        _burn(sender, amount);
    }
}
