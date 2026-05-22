// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

/// @title BaseTest
/// @notice Shared test scaffolding for Old Money. All unit / integration / fuzz tests inherit
///         from this so actor addresses, labels, and helper conventions stay consistent.
abstract contract BaseTest is Test {
    // -- Canonical actors. Set in setUp() of derived tests via labelAll(). --
    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal trustees = makeAddr("trustees");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal stranger = makeAddr("stranger");

    // -- Common constants. --
    uint256 internal constant WAD = 1e18;

    function setUp() public virtual {
        _labelActors();
    }

    function _labelActors() internal {
        vm.label(owner, "owner");
        vm.label(guardian, "guardian");
        vm.label(trustees, "trustees");
        vm.label(alice, "alice");
        vm.label(bob, "bob");
        vm.label(carol, "carol");
        vm.label(stranger, "stranger");
    }

    /// @notice Generate a deterministic (privateKey, address) pair for signature tests.
    function _makeSigner(
        string memory name
    ) internal returns (uint256 privateKey, address account) {
        (account, privateKey) = makeAddrAndKey(name);
    }
}
