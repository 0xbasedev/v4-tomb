// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "../utils/BaseTest.sol";
import {IMasonryMintableLevel} from "../../src/masonry/IMasonryRuntime.sol";
import {MasonryChamber} from "../../src/masonry/MasonryChamber.sol";
import {MasonryTreasury} from "../../src/masonry/MasonryTreasury.sol";
import {MockLevel, MockLp, MockTwap} from "./MasonryTreasury.t.sol";

contract MasonryChamberTest is BaseTest {
    MockLevel internal level;
    MockLp internal lp;
    MockTwap internal oracle;
    MasonryChamber internal chamber;
    MasonryTreasury internal treasury;
    address internal daoWallet;
    address internal arbitrage;
    uint256 internal startTime;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        startTime = block.timestamp + 1 hours;
        level = new MockLevel();
        lp = new MockLp();
        oracle = new MockTwap();
        daoWallet = makeAddr("daoWallet");
        arbitrage = makeAddr("arbitrage");
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        chamber =
            new MasonryChamber(IERC20(address(lp)), IERC20(address(level)), predicted, daoWallet, arbitrage);
        treasury = new MasonryTreasury(
            IMasonryMintableLevel(address(level)), chamber, oracle, startTime, 200, 30 minutes, address(this)
        );
        assertEq(address(treasury), predicted);
        level.mint(address(this), 1_000_000 ether);
        lp.mint(alice, 1000 ether);
        vm.startPrank(alice);
        lp.approve(address(chamber), type(uint256).max);
        chamber.stake(400 ether);
        vm.stopPrank();
    }

    function _expand() internal {
        vm.warp(startTime + 1);
        oracle.set(1.05e18, block.timestamp, true);
        treasury.allocateExpansion();
    }

    function test_WithdrawLockedUntilStakeCooldown() public {
        vm.prank(alice);
        vm.expectRevert(MasonryChamber.StakeLocked.selector);
        chamber.withdraw(10 ether);
        _expand();
        vm.prank(alice);
        vm.expectRevert(MasonryChamber.StakeLocked.selector);
        chamber.withdraw(10 ether);
        vm.warp(block.timestamp + 5 hours);
        uint256 beforeLp = lp.balanceOf(alice);
        vm.prank(alice);
        chamber.withdraw(100 ether);
        assertEq(lp.balanceOf(alice), beforeLp + 100 ether);
        assertGt(chamber.pending(alice), 0);
        assertEq(level.balanceOf(alice), 0, "ordinary withdraw does not pay LEVEL");
    }

    function test_OrdinaryClaimDoesNotResetStakeLock() public {
        _expand();
        vm.prank(alice);
        chamber.claim();
        assertGt(level.balanceOf(alice), 0);
        vm.prank(alice);
        vm.expectRevert(MasonryChamber.StakeLocked.selector);
        chamber.withdraw(10 ether);
        vm.prank(alice);
        vm.expectRevert(MasonryChamber.ClaimLocked.selector);
        chamber.claim();
    }

    function test_ExitNowSplitsLpAndForfeitsRewardsWithoutPayingUserLevel() public {
        _expand();
        uint256 pending = chamber.pending(alice);
        assertGt(pending, 0);
        uint256 userLevelBefore = level.balanceOf(alice);
        uint256 userLpBefore = lp.balanceOf(alice);
        uint256 staked = chamber.balanceOf(alice);

        vm.prank(alice);
        chamber.exitNow();

        assertEq(chamber.balanceOf(alice), 0);
        assertEq(chamber.pending(alice), 0);
        assertEq(lp.balanceOf(alice), userLpBefore + staked / 2);
        assertEq(lp.balanceOf(daoWallet), staked - staked / 2);
        assertEq(level.balanceOf(arbitrage), pending);
        assertEq(level.balanceOf(alice), userLevelBefore, "no LEVEL paid to user - not a Fire Tax exit");
        assertEq(lp.balanceOf(address(chamber)), 0);
    }

    function test_ExitNowCannotBeUsedAsTaxFreeLevelExit() public {
        _expand();
        uint256 userLevelBefore = level.balanceOf(alice);
        vm.prank(alice);
        chamber.exitNow();
        assertEq(level.balanceOf(alice), userLevelBefore);
        assertGt(level.balanceOf(arbitrage), 0);
        // User holds LP only; no vault redeem or xTOMB transfer occurred.
        assertGt(lp.balanceOf(alice), 0);
    }
}
