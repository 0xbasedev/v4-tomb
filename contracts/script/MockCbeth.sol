// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockCbeth
 * @notice Testnet stand-in for Coinbase Wrapped Staked ETH. Used in deploys on chains
 *         where real cbETH does not exist (Base Sepolia, Ethereum Sepolia). 18 decimals
 *         to match real cbETH. Permissionless mint so testers can fund themselves.
 *
 * @dev    NEVER deploy this on a chain where real cbETH exists — `Addresses.hasCbeth()`
 *         protects against that in Deploy.s.sol.
 */
contract MockCbeth is ERC20 {
    constructor() ERC20("Mock cbETH (Old Money testnet)", "cbETH") {}

    /// @notice Permissionless mint for testnet faucet use.
    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}
