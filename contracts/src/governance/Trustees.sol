// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title Trustees
 * @notice Two-tier access pattern shared by all Old Money contracts: an `owner` who can rotate
 *         the `trustees` address, and a `trustees` address (a single account) authorized to
 *         perform protocol-state mutations.
 * @dev    Direct port of Tomb Finance's `Operator` contract (contracts/owner/Operator.sol in the
 *         canonical fork at bombmoney/bomb-contracts), with two non-logic-changing modernizations:
 *           - Inherits OZ v5 `Ownable2Step` instead of single-step `Ownable` for safer admin
 *             rotation. Identical user-facing behavior outside the transfer flow itself.
 *           - Uses custom errors instead of `require` strings (gas, behavior-identical).
 *
 *         "Trustees" is the themed rename of Tomb's "Operator". Convention across Old Money:
 *         the Treasury contract becomes the trustees of every token and core contract once
 *         deployment finishes.
 */
abstract contract Trustees is Ownable2Step {
    address private _trustees;

    event TrusteesTransferred(address indexed previousTrustees, address indexed newTrustees);

    error NotTrustees();
    error ZeroTrusteesAddress();

    modifier onlyTrustees() {
        if (msg.sender != _trustees) revert NotTrustees();
        _;
    }

    constructor() Ownable(msg.sender) {
        _trustees = msg.sender;
        emit TrusteesTransferred(address(0), msg.sender);
    }

    /// @notice Returns the current trustees address.
    function trustees() public view returns (address) {
        return _trustees;
    }

    /// @notice True if the caller is the current trustees.
    function isTrustees() public view returns (bool) {
        return msg.sender == _trustees;
    }

    /// @notice Rotate the trustees role. Only the owner can call this.
    /// @dev Production owner is the Timelock; production trustees is the Treasury contract.
    function transferTrustees(
        address newTrustees
    ) public onlyOwner {
        _transferTrustees(newTrustees);
    }

    function _transferTrustees(
        address newTrustees
    ) internal {
        if (newTrustees == address(0)) revert ZeroTrusteesAddress();
        emit TrusteesTransferred(_trustees, newTrustees);
        _trustees = newTrustees;
    }

    // ---------------------------------------------------------------------
    // Tomb-shape aliases — let our tokens satisfy IBasisAsset (operator/isOperator/
    // transferOperator) without renaming the themed `trustees` surface.
    // ---------------------------------------------------------------------

    /// @notice Tomb-shape alias for `trustees()`. Same address, same semantics.
    function operator() public view returns (address) {
        return _trustees;
    }

    /// @notice Tomb-shape alias for `isTrustees()`.
    function isOperator() public view returns (bool) {
        return msg.sender == _trustees;
    }

    /// @notice Tomb-shape alias for `transferTrustees`. Owner-only, same effect.
    function transferOperator(
        address newOperator
    ) external onlyOwner {
        _transferTrustees(newOperator);
    }
}
