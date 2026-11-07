// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {MasonryGenesisSchedule} from "../../src/masonry/MasonryGenesisSchedule.sol";
import {MasonryGenesisPass} from "../../src/masonry/MasonryGenesisPass.sol";
import {MockMasonryUSDC} from "../unit/MasonryGenesisLPBurnFee.t.sol";

contract MasonryGenesisPassUpgradeTest is Test {
    MasonryGenesisSchedule schedule;
    MasonryGenesisPass pass;
    MockMasonryUSDC usdc;
    address constant TREASURY = address(0x777);
    address constant USER = address(0xA11CE);

    event Upgraded(address indexed holder, uint256 indexed tokenId, MasonryGenesisPass.Tier oldTier, MasonryGenesisPass.Tier newTier, uint256 paid);

    function setUp() public {
        usdc = new MockMasonryUSDC();
        schedule = new MasonryGenesisSchedule(block.timestamp + 2 days, address(this));
        pass = new MasonryGenesisPass(usdc, TREASURY, schedule);
    }

    function _buy(MasonryGenesisPass.Tier t) internal {
        usdc.mint(USER, 1000e6);
        vm.startPrank(USER);
        usdc.approve(address(pass), type(uint256).max);
        pass.purchase(t);
        vm.stopPrank();
    }

    function _up(MasonryGenesisPass.Tier from, MasonryGenesisPass.Tier to, uint256 diff) internal {
        _buy(from);
        uint256 t0 = usdc.balanceOf(TREASURY);
        vm.expectEmit(true, true, false, true);
        emit Upgraded(USER, 1, from, to, diff);
        vm.prank(USER);
        assertEq(pass.upgrade(to), diff);
        assertEq(usdc.balanceOf(TREASURY) - t0, diff);
        assertEq(uint8(pass.tierOf(USER)), uint8(to));
        assertEq(pass.ownerOf(1), USER);
        assertEq(pass.balanceOf(USER), 1);
    }

    function testGenesisToPro() public { _up(MasonryGenesisPass.Tier.Genesis, MasonryGenesisPass.Tier.Pro, 50e6); }
    function testGenesisToUltra() public { _up(MasonryGenesisPass.Tier.Genesis, MasonryGenesisPass.Tier.Ultra, 450e6); }
    function testProToUltra() public { _up(MasonryGenesisPass.Tier.Pro, MasonryGenesisPass.Tier.Ultra, 400e6); }

    function testChainedUpgradeTotalsUltra() public {
        _up(MasonryGenesisPass.Tier.Genesis, MasonryGenesisPass.Tier.Pro, 50e6);
        vm.prank(USER);
        pass.upgrade(MasonryGenesisPass.Tier.Ultra);
        assertEq(usdc.balanceOf(TREASURY), 500e6);
    }

    function testDowngradeAndSameTierRevert() public {
        _buy(MasonryGenesisPass.Tier.Pro);
        vm.startPrank(USER);
        vm.expectRevert(MasonryGenesisPass.InvalidPurchase.selector);
        pass.upgrade(MasonryGenesisPass.Tier.Pro);
        vm.expectRevert(MasonryGenesisPass.InvalidPurchase.selector);
        pass.upgrade(MasonryGenesisPass.Tier.Genesis);
        vm.expectRevert(MasonryGenesisPass.InvalidPurchase.selector);
        pass.upgrade(MasonryGenesisPass.Tier.None);
        vm.stopPrank();
    }

    function testNoPassReverts() public {
        usdc.mint(USER, 1000e6);
        vm.startPrank(USER);
        usdc.approve(address(pass), type(uint256).max);
        vm.expectRevert(MasonryGenesisPass.InvalidPurchase.selector);
        pass.upgrade(MasonryGenesisPass.Tier.Pro);
        vm.stopPrank();
    }

    function testAfterEndReverts() public {
        _buy(MasonryGenesisPass.Tier.Genesis);
        vm.warp(schedule.end());
        vm.prank(USER);
        vm.expectRevert(MasonryGenesisPass.InvalidPurchase.selector);
        pass.upgrade(MasonryGenesisPass.Tier.Pro);
    }

    function testInsufficientAllowanceNoStateChange() public {
        _buy(MasonryGenesisPass.Tier.Genesis);
        vm.startPrank(USER);
        usdc.approve(address(pass), 49e6);
        vm.expectRevert();
        pass.upgrade(MasonryGenesisPass.Tier.Pro);
        vm.stopPrank();
        assertEq(uint8(pass.tierOf(USER)), uint8(MasonryGenesisPass.Tier.Genesis));
        assertEq(usdc.balanceOf(TREASURY), 50e6);
    }

    function testInsufficientBalanceNoStateChange() public {
        _buy(MasonryGenesisPass.Tier.Genesis);
        uint256 drain = usdc.balanceOf(USER) - 10e6;
        vm.prank(USER);
        usdc.transfer(address(0xdead), drain);
        vm.prank(USER);
        vm.expectRevert();
        pass.upgrade(MasonryGenesisPass.Tier.Ultra);
        assertEq(uint8(pass.tierOf(USER)), uint8(MasonryGenesisPass.Tier.Genesis));
        assertEq(usdc.balanceOf(TREASURY), 50e6);
    }

    function testStillSoulboundAfterUpgrade() public {
        _up(MasonryGenesisPass.Tier.Genesis, MasonryGenesisPass.Tier.Ultra, 450e6);
        vm.startPrank(USER);
        vm.expectRevert(MasonryGenesisPass.Soulbound.selector);
        pass.transferFrom(USER, address(0xB0B), 1);
        vm.expectRevert(MasonryGenesisPass.Soulbound.selector);
        pass.safeTransferFrom(USER, address(0xB0B), 1);
        vm.stopPrank();
    }

    function testFuzzTotalPaidEqualsTargetPrice(uint8 a, uint8 b) public {
        uint8 from = uint8(bound(a, 1, 2));
        uint8 to = uint8(bound(b, from + 1, 3));
        _buy(MasonryGenesisPass.Tier(from));
        vm.prank(USER);
        pass.upgrade(MasonryGenesisPass.Tier(to));
        assertEq(usdc.balanceOf(TREASURY), pass.price(MasonryGenesisPass.Tier(to)));
    }
}
