// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MasonryCompoundGate} from "../../src/masonry/MasonryCompoundGate.sol";

contract MasonryCompoundGateTest is Test {
    MasonryCompoundGate internal gate;
    address internal constant USER = address(0xBEEF);
    bytes32 internal constant POOL_A = keccak256("genesis:pool:1");
    bytes32 internal constant POOL_B = keccak256("genesis:pool:2");

    function setUp() public {
        gate = new MasonryCompoundGate();
        gate.setExecutor(address(this), true);
    }

    function test_PerPoolIndependenceWithSameWallet() public {
        gate.consume(USER, POOL_A);
        gate.consume(USER, POOL_B);
        vm.expectRevert(abi.encodeWithSelector(MasonryCompoundGate.CooldownActive.selector, block.timestamp + 3 hours));
        gate.consume(USER, POOL_A);
        vm.warp(block.timestamp + 3 hours);
        gate.consume(USER, POOL_A);
        gate.consume(USER, POOL_B);
    }

    function test_DifferentWalletsHaveDifferentTimers() public {
        gate.consume(USER, POOL_A);
        gate.consume(address(0xCAFE), POOL_A);
        vm.expectRevert(abi.encodeWithSelector(MasonryCompoundGate.CooldownActive.selector, block.timestamp + 3 hours));
        gate.consume(USER, POOL_A);
    }

    function test_UnauthorizedExecutorIsRejected() public {
        vm.expectRevert(MasonryCompoundGate.NotExecutor.selector);
        vm.prank(USER);
        gate.consume(USER, POOL_A);
    }

    function test_ThreeHourLockIsNotOwnerConfigurable() public view {
        assertEq(gate.COOLDOWN(), 3 hours);
    }
}
