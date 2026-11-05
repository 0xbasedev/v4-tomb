// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MasonryLinearVesting} from "../../src/masonry/MasonryLinearVesting.sol";

contract MasonryTestToken is ERC20 {
    constructor() ERC20("Test LEVEL", "tLEVEL") {}

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract MasonryLinearVestingTest is Test {
    MasonryTestToken internal token;
    MasonryLinearVesting internal vesting;
    address internal beneficiary = address(0xBEEF);
    uint64 internal vestingStart;
    uint64 internal constant DURATION = 180 days;

    function setUp() public {
        token = new MasonryTestToken();
        token.mint(address(this), 1000e18);
        vestingStart = uint64(block.timestamp + 1 days);
        vesting = new MasonryLinearVesting(token, beneficiary, vestingStart, DURATION, address(this));
        token.approve(address(vesting), 1000e18);
    }

    function test_InitialReleaseAndSixMonthLinearVesting() public {
        vesting.fund(100e18, 900e18);
        assertEq(token.balanceOf(beneficiary), 100e18);
        assertEq(token.balanceOf(address(vesting)), 900e18);
        assertEq(vesting.releasable(), 0);

        vm.warp(vestingStart + DURATION / 2);
        assertEq(vesting.releasable(), 450e18);
        vm.prank(address(0xCAFE));
        vesting.release();
        assertEq(token.balanceOf(beneficiary), 550e18);

        vm.warp(vestingStart + DURATION);
        vesting.release();
        assertEq(token.balanceOf(beneficiary), 1000e18);
        assertEq(token.balanceOf(address(vesting)), 0);
    }

    function test_DoubleFundingIsForbidden() public {
        vesting.fund(100e18, 900e18);
        vm.expectRevert(MasonryLinearVesting.AlreadyFunded.selector);
        vesting.fund(1, 1);
    }

    function test_NoEarlyVesting() public {
        vesting.fund(100e18, 900e18);
        vm.warp(vestingStart - 1);
        assertEq(vesting.releasable(), 0);
        vm.expectRevert(MasonryLinearVesting.NothingToRelease.selector);
        vesting.release();
    }

    function test_OnlyOwnerMayFund() public {
        vm.expectRevert();
        vm.prank(beneficiary);
        vesting.fund(100e18, 900e18);
    }
}
