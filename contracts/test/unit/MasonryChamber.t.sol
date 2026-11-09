// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "../utils/BaseTest.sol";
import {IMasonryMintableLevel} from "../../src/masonry/IMasonryRuntime.sol";
import {MasonryChamber} from "../../src/masonry/MasonryChamber.sol";
import {MockFireTax} from "../utils/MockFireTax.sol";
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
    MockFireTax internal fireTax;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        startTime = block.timestamp + 1 hours;
        level = new MockLevel();
        lp = new MockLp();
        oracle = new MockTwap();
        daoWallet = makeAddr("daoWallet");
        arbitrage = makeAddr("arbitrage");
        fireTax = new MockFireTax();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        chamber =
            new MasonryChamber(IERC20(address(lp)), IERC20(address(level)), predicted, daoWallet, arbitrage, fireTax);
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
        uint256 fee = 100 ether * uint256(fireTax.currentWithdrawFeeBps()) / 10_000;
        vm.prank(alice);
        chamber.withdraw(100 ether);
        assertEq(lp.balanceOf(alice), beforeLp + 100 ether - fee);
        assertEq(lp.balanceOf(daoWallet), fee);
        assertGt(chamber.pending(alice), 0);
        assertEq(level.balanceOf(alice), 0, "ordinary withdraw does not pay LEVEL");
    }

    function test_OrdinaryWithdrawChargesLiveFireTaxAtPegMinusTenAndCap() public {
        vm.warp(block.timestamp + 6 hours + 1);
        assertEq(chamber.withdrawFeeBps(), 300, "peg / baseline");
        uint256 before = lp.balanceOf(alice);
        vm.prank(alice);
        chamber.withdraw(100 ether);
        assertEq(lp.balanceOf(alice), before + 97 ether);
        assertEq(lp.balanceOf(daoWallet), 3 ether);

        fireTax.set(1200);
        assertEq(chamber.withdrawFeeBps(), 1200, "-10% / hard cap");
        before = lp.balanceOf(alice);
        uint256 dao = lp.balanceOf(daoWallet);
        vm.prank(alice);
        chamber.withdraw(100 ether);
        assertEq(lp.balanceOf(alice), before + 88 ether);
        assertEq(lp.balanceOf(daoWallet), dao + 12 ether);

        fireTax.set(1201);
        vm.expectRevert(MasonryChamber.InvalidConfiguration.selector);
        chamber.withdrawFeeBps();
        vm.prank(alice);
        vm.expectRevert(MasonryChamber.InvalidConfiguration.selector);
        chamber.withdraw(1 ether);

        fireTax.set(300);
        uint256 dustDao = lp.balanceOf(daoWallet);
        vm.prank(alice);
        chamber.withdraw(1);
        assertEq(lp.balanceOf(daoWallet), dustDao, "1 wei * 300 / 10000 rounds to 0");
    }

    function test_OrdinaryClaimDoesNotResetStakeLock() public {
        _expand();
        vm.prank(alice);
        vm.expectRevert(MasonryChamber.ClaimLocked.selector);
        chamber.claim();
        vm.warp(block.timestamp + 5 hours);
        vm.prank(alice);
        chamber.claim();
        assertGt(level.balanceOf(alice), 0);
        // Claim must not restart the already-elapsed stake cooldown.
        uint256 fee = 10 ether * uint256(fireTax.currentWithdrawFeeBps()) / 10_000;
        uint256 beforeLp = lp.balanceOf(alice);
        vm.prank(alice);
        chamber.withdraw(10 ether);
        assertEq(lp.balanceOf(alice), beforeLp + 10 ether - fee);
        vm.prank(alice);
        vm.expectRevert(MasonryChamber.ClaimLocked.selector);
        chamber.claim();
    }

    function test_DepositResetsOwnClocksOnly() public {
        address bob = makeAddr("bob");
        lp.mint(bob, 100 ether);
        vm.startPrank(bob);
        lp.approve(address(chamber), type(uint256).max);
        chamber.stake(50 ether);
        vm.stopPrank();
        uint256 bobStake = chamber.stakeUnlockAt(bob);
        uint256 bobClaim = chamber.claimUnlockAt(bob);
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        chamber.stake(10 ether);
        assertEq(chamber.stakeUnlockAt(alice), block.timestamp + 6 hours);
        assertEq(chamber.claimUnlockAt(alice), block.timestamp + 6 hours);
        assertEq(chamber.stakeUnlockAt(bob), bobStake, "must not grief other users");
        assertEq(chamber.claimUnlockAt(bob), bobClaim);
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
