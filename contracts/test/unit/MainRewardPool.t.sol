// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";

import {MainRewardPool} from "../../src/distribution/MainRewardPool.sol";
import {OldMoney} from "../../src/tokens/OldMoney.sol";

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

contract MainRewardPoolTest is BaseTest {
    MainRewardPool internal pool;
    OldMoney internal money;
    MockLp internal lp;

    uint256 internal poolStart;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        poolStart = block.timestamp + 1 hours;

        vm.prank(owner);
        money = new OldMoney();

        vm.prank(owner);
        pool = new MainRewardPool(address(money), poolStart);

        lp = new MockLp("LP", "LP");

        uint256 rewards = pool.TOTAL_REWARDS();
        vm.prank(owner);
        money.mint(address(pool), rewards);
    }

    // ---------------------------------------------------------------------
    // Epoch boundary math — the only meaningful divergence from GenesisRewardPool
    // ---------------------------------------------------------------------

    function test_Constructor_SetsTwoEpochs() public view {
        assertEq(pool.TOTAL_REWARDS(), 140_000 ether);
        assertEq(pool.EPOCH_0_REWARDS(), 80_000 ether);
        assertEq(pool.EPOCH_1_REWARDS(), 60_000 ether);
        assertEq(pool.epochEndTimes(0), poolStart + 4 days);
        assertEq(pool.epochEndTimes(1), poolStart + 9 days);
        assertEq(pool.epochEndTimes(2), 0);
        // 80000e18 / (4 days) and 60000e18 / (5 days).
        assertEq(pool.epochMoneyPerSecond(0), uint256(80_000 ether) / 4 days);
        assertEq(pool.epochMoneyPerSecond(1), uint256(60_000 ether) / 5 days);
        assertEq(pool.epochMoneyPerSecond(2), 0);
    }

    function test_GeneratedReward_Epoch0Only() public view {
        // Halfway through epoch 0 (day 2 of 4). Allow integer-division dust (< 1 wei * sec).
        uint256 reward = pool.getGeneratedReward(poolStart, poolStart + 2 days);
        assertApproxEqRel(reward, 40_000 ether, 0.0001e18); // 0.01% tolerance for dust
    }

    function test_GeneratedReward_Epoch1Only() public view {
        uint256 reward = pool.getGeneratedReward(poolStart + 4 days, poolStart + 9 days);
        assertApproxEqRel(reward, 60_000 ether, 0.0001e18);
    }

    function test_GeneratedReward_CrossesEpochBoundary() public view {
        // [day 3, day 6] → 1 day of epoch 0 + 2 days of epoch 1.
        uint256 reward = pool.getGeneratedReward(poolStart + 3 days, poolStart + 6 days);
        uint256 r0 = pool.epochMoneyPerSecond(0) * 1 days;
        uint256 r1 = pool.epochMoneyPerSecond(1) * 2 days;
        assertEq(reward, r0 + r1); // exact since we read the rates back from the contract
    }

    function test_GeneratedReward_FullSpan() public view {
        uint256 reward = pool.getGeneratedReward(poolStart, poolStart + 9 days);
        assertApproxEqRel(reward, 140_000 ether, 0.0001e18);
    }

    function test_GeneratedReward_CapsAtPoolEnd() public view {
        uint256 reward = pool.getGeneratedReward(poolStart, poolStart + 30 days);
        assertApproxEqRel(reward, 140_000 ether, 0.0001e18);
    }

    function test_GeneratedReward_ZeroBeforePoolStart() public view {
        // Past the pool window altogether.
        assertEq(pool.getGeneratedReward(poolStart - 1 days, poolStart - 30 minutes), 0);
    }

    // ---------------------------------------------------------------------
    // End-to-end staking through both epochs
    // ---------------------------------------------------------------------

    function test_StakerEarnsAcrossBothEpochs() public {
        vm.prank(owner);
        pool.add(100, IERC20(address(lp)), false, 0);
        _stake(alice, 100 ether);

        // Day 5 (end of epoch 0). Alice is sole staker; should have ~80k.
        vm.warp(poolStart + 4 days);
        assertApproxEqRel(pool.pendingMoney(0, alice), 80_000 ether, 0.0001e18);

        // Day 10 (end of epoch 1). Alice should have ~140k total.
        vm.warp(poolStart + 9 days);
        assertApproxEqRel(pool.pendingMoney(0, alice), 140_000 ether, 0.0001e18);
    }

    function _stake(
        address who,
        uint256 amount
    ) internal {
        lp.mint(who, amount);
        vm.prank(who);
        lp.approve(address(pool), amount);
        vm.prank(who);
        pool.deposit(0, amount);
    }
}
