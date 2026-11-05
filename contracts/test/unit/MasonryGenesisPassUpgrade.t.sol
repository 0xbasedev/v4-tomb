// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {MasonryGenesisSchedule} from "../../src/masonry/MasonryGenesisSchedule.sol";
import {MasonryGenesisPass} from "../../src/masonry/MasonryGenesisPass.sol";
import {MockMasonryUSDC} from "./MasonryGenesisLPBurnFee.t.sol";

contract MasonryGenesisPassUpgradeTest is Test {
    MasonryGenesisPass private pass;
    MockMasonryUSDC private usdc;
    MasonryGenesisSchedule private schedule;
    address private constant TREASURY = address(0x7EA5);
    address private constant ALICE = address(0xA11CE);
    uint256 private start;

    function setUp() public {
        usdc = new MockMasonryUSDC();
        start = block.timestamp + 2 days;
        schedule = new MasonryGenesisSchedule(start, address(this));
        pass = new MasonryGenesisPass(usdc, TREASURY, schedule);
        usdc.mint(ALICE, 1_000e6);
        vm.prank(ALICE);
        usdc.approve(address(pass), type(uint256).max);
    }

    function _buy(
        MasonryGenesisPass.Tier t
    ) private returns (uint256 id) {
        vm.prank(ALICE);
        id = pass.purchase(t);
    }

    function _up(
        MasonryGenesisPass.Tier t
    ) private returns (uint256 id) {
        vm.prank(ALICE);
        id = pass.upgrade(t);
    }

    function test_upgradePaysOnlyTheDifference() public {
        uint256 id = _buy(MasonryGenesisPass.Tier.Genesis);
        assertEq(usdc.balanceOf(TREASURY), 50e6);
        assertEq(_up(MasonryGenesisPass.Tier.Pro), id, "same token");
        assertEq(usdc.balanceOf(TREASURY), 100e6);
        assertEq(_up(MasonryGenesisPass.Tier.Ultra), id);
        assertEq(usdc.balanceOf(TREASURY), 500e6);
        assertEq(uint8(pass.tierOf(ALICE)), uint8(MasonryGenesisPass.Tier.Ultra));
        assertEq(pass.balanceOf(ALICE), 1, "still one soulbound pass");
        assertEq(pass.tokenOf(ALICE), id);
    }

    function test_genesisThenUltraEqualsBuyingUltra() public {
        _buy(MasonryGenesisPass.Tier.Genesis);
        _up(MasonryGenesisPass.Tier.Ultra);
        assertEq(usdc.balanceOf(TREASURY), pass.price(MasonryGenesisPass.Tier.Ultra));
        assertEq(usdc.balanceOf(ALICE), 500e6);
    }

    function test_upgradeEmitsAndKeepsSoulbound() public {
        uint256 id = _buy(MasonryGenesisPass.Tier.Genesis);
        vm.expectEmit(true, true, false, true);
        emit MasonryGenesisPass.Upgraded(ALICE, id, MasonryGenesisPass.Tier.Genesis, MasonryGenesisPass.Tier.Pro, 50e6);
        _up(MasonryGenesisPass.Tier.Pro);
        vm.prank(ALICE);
        vm.expectRevert(MasonryGenesisPass.Soulbound.selector);
        pass.transferFrom(ALICE, address(0xB0B), id);
    }

    function test_upgradeRequiresAHigherTier() public {
        vm.expectRevert(MasonryGenesisPass.InvalidPurchase.selector);
        _up(MasonryGenesisPass.Tier.Pro); // none held

        _buy(MasonryGenesisPass.Tier.Pro);
        vm.expectRevert(MasonryGenesisPass.InvalidPurchase.selector);
        _up(MasonryGenesisPass.Tier.Pro); // same
        vm.expectRevert(MasonryGenesisPass.InvalidPurchase.selector);
        _up(MasonryGenesisPass.Tier.Genesis); // lower
        vm.expectRevert(MasonryGenesisPass.InvalidPurchase.selector);
        _up(MasonryGenesisPass.Tier.None);
    }

    function test_cannotBuyASecondPass() public {
        _buy(MasonryGenesisPass.Tier.Genesis);
        vm.expectRevert(MasonryGenesisPass.InvalidPurchase.selector);
        _buy(MasonryGenesisPass.Tier.Pro);
    }

    function test_upgradeClosesWhenGenesisEnds() public {
        _buy(MasonryGenesisPass.Tier.Genesis);
        vm.warp(schedule.end());
        vm.expectRevert(MasonryGenesisPass.InvalidPurchase.selector);
        _up(MasonryGenesisPass.Tier.Pro);
    }

    function test_upgradeBeforeStartIsAllowed() public {
        _buy(MasonryGenesisPass.Tier.Genesis);
        assertLt(block.timestamp, start);
        _up(MasonryGenesisPass.Tier.Ultra);
        assertEq(uint8(pass.tierOf(ALICE)), uint8(MasonryGenesisPass.Tier.Ultra));
    }

    function test_upgradeNeedsUsdc() public {
        _buy(MasonryGenesisPass.Tier.Genesis);
        vm.prank(ALICE);
        usdc.transfer(address(0xDEAD), 940e6); // leaves 10 USDC
        vm.expectRevert();
        _up(MasonryGenesisPass.Tier.Ultra);
        assertEq(uint8(pass.tierOf(ALICE)), uint8(MasonryGenesisPass.Tier.Genesis), "unchanged on failure");
    }
}
