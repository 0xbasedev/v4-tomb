// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";

import {ShareRewardPool} from "../../src/distribution/ShareRewardPool.sol";
import {ShareToken} from "../../src/tokens/ShareToken.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockLp is ERC20 {
    constructor(
        string memory n,
        string memory s
    ) ERC20(n, s) {}

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract ShareRewardPoolTest is BaseTest {
    ShareRewardPool internal pool;
    ShareToken internal estate;
    MockLp internal lp;

    address internal communityFund = makeAddr("communityFund");
    address internal devFund = makeAddr("devFund");
    address internal farmingPool = makeAddr("farmingPool");

    uint256 internal poolStart;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        poolStart = block.timestamp + 1 hours;

        vm.prank(owner);
        estate = new ShareToken(poolStart, communityFund, devFund, owner);

        vm.prank(owner);
        pool = new ShareRewardPool(address(estate), poolStart, owner);

        lp = new MockLp("LP", "LP");

        // Mint ESTATE supply via distributeReward to farmingPool, then forward the
        // pool's full allocation to the reward pool.
        vm.prank(owner);
        estate.distributeReward(farmingPool);
        uint256 rewards = pool.TOTAL_REWARDS();
        vm.prank(farmingPool);
        estate.transfer(address(pool), rewards);
    }

    function test_Constructor_StoresParams() public view {
        assertEq(address(pool.share()), address(estate));
        assertEq(pool.TOTAL_REWARDS(), 59_500 ether);
        assertEq(pool.RUNNING_TIME(), 370 days);
        assertEq(pool.SHARE_PER_SECOND(), uint256(59_500 ether) / 370 days);
        assertEq(pool.poolEndTime(), poolStart + 370 days);
    }

    function test_StakerEarnsAcrossYear() public {
        vm.prank(owner);
        pool.add(100, IERC20(address(lp)), false, 0);

        lp.mint(alice, 100 ether);
        vm.prank(alice);
        lp.approve(address(pool), 100 ether);
        vm.prank(alice);
        pool.deposit(0, 100 ether);

        // Halfway through (185 days of 370).
        vm.warp(poolStart + 185 days);
        uint256 expected = 185 days * pool.SHARE_PER_SECOND();
        assertApproxEqAbs(pool.pendingShare(0, alice), expected, 1);

        // After the full year — capped at TOTAL_REWARDS (modulo dust).
        vm.warp(poolStart + 400 days);
        uint256 full = 370 days * pool.SHARE_PER_SECOND();
        assertApproxEqAbs(pool.pendingShare(0, alice), full, 1);
    }

    function test_Withdraw_PaysSharePendingThenReturnsLp() public {
        vm.prank(owner);
        pool.add(100, IERC20(address(lp)), false, 0);

        lp.mint(alice, 100 ether);
        vm.prank(alice);
        lp.approve(address(pool), 100 ether);
        vm.prank(alice);
        pool.deposit(0, 100 ether);

        vm.warp(poolStart + 30 days);
        uint256 expected = 30 days * pool.SHARE_PER_SECOND();
        uint256 estateBefore = estate.balanceOf(alice);

        vm.prank(alice);
        pool.withdraw(0, 100 ether);

        assertEq(lp.balanceOf(alice), 100 ether);
        assertApproxEqAbs(estate.balanceOf(alice) - estateBefore, expected, 1);
    }
}
