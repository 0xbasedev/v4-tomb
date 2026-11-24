// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";

import {GenesisRewardPool} from "../../src/distribution/GenesisRewardPool.sol";
import {PegToken} from "../../src/tokens/PegToken.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Mock LP token — 18-decimal, permissionless mint for tests.
contract MockLp is ERC20 {
    constructor(
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) {}

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract GenesisRewardPoolTest is BaseTest {
    GenesisRewardPool internal pool;
    PegToken internal peg;
    MockLp internal lp;
    MockLp internal lp2;

    uint256 internal poolStart;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        poolStart = block.timestamp + 1 hours;

        vm.prank(owner);
        peg = new PegToken("Peg Token", "PEG");

        vm.prank(owner);
        pool = new GenesisRewardPool(address(peg), poolStart);

        lp = new MockLp("LP token", "LP");
        lp2 = new MockLp("LP token 2", "LP2");

        // Treasury would normally pre-fund the pool via PEG.distributeReward.
        // In this test, owner is the trustees on PEG (set in PegToken constructor
        // since owner deployed it). owner mints the pool's full reward allocation.
        // Extract the constant first — otherwise pool.TOTAL_REWARDS() consumes the prank.
        uint256 rewards = pool.TOTAL_REWARDS();
        vm.prank(owner);
        peg.mint(address(pool), rewards);
    }

    // ---------------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------------

    function test_Constructor_StoresParams() public view {
        assertEq(address(pool.peg()), address(peg));
        assertEq(pool.poolStartTime(), poolStart);
        assertEq(pool.poolEndTime(), poolStart + 1 days);
        assertEq(pool.operator(), owner);
        assertEq(pool.TOTAL_REWARDS(), 11_000 ether);
        assertEq(pool.RUNNING_TIME(), 1 days);
        // 11000e18 / 86400 ≈ 0.1273e18.
        assertApproxEqAbs(pool.PEG_PER_SECOND(), uint256(11_000 ether) / 1 days, 0);
    }

    function test_Constructor_RejectsPastStart() public {
        vm.expectRevert(GenesisRewardPool.StartTimeInPast.selector);
        new GenesisRewardPool(address(peg), block.timestamp - 1);
    }

    // ---------------------------------------------------------------------
    // Pool management
    // ---------------------------------------------------------------------

    function test_Add_OnlyOperator() public {
        vm.prank(stranger);
        vm.expectRevert(GenesisRewardPool.NotOperator.selector);
        pool.add(100, IERC20(address(lp)), false, 0);
    }

    function test_Add_RegistersPool() public {
        vm.prank(owner);
        pool.add(100, IERC20(address(lp)), false, 0);

        (IERC20 token, uint256 allocPoint, uint256 lastRewardTime, uint256 accPerShare, bool isStarted) =
            pool.poolInfo(0);
        assertEq(address(token), address(lp));
        assertEq(allocPoint, 100);
        assertEq(lastRewardTime, poolStart); // Defaulted to poolStartTime.
        assertEq(accPerShare, 0);
        assertTrue(isStarted);
        assertEq(pool.totalAllocPoint(), 100);
    }

    function test_Add_RejectsDuplicateToken() public {
        vm.prank(owner);
        pool.add(100, IERC20(address(lp)), false, 0);
        vm.prank(owner);
        vm.expectRevert(GenesisRewardPool.PoolAlreadyExists.selector);
        pool.add(50, IERC20(address(lp)), false, 0);
    }

    function test_Set_UpdatesAllocPoint() public {
        vm.prank(owner);
        pool.add(100, IERC20(address(lp)), false, 0);
        vm.prank(owner);
        pool.set(0, 250);
        (, uint256 allocPoint,,,) = pool.poolInfo(0);
        assertEq(allocPoint, 250);
        assertEq(pool.totalAllocPoint(), 250);
    }

    function test_SetOperator_Rotates() public {
        vm.prank(owner);
        pool.setOperator(alice);
        assertEq(pool.operator(), alice);
    }

    // ---------------------------------------------------------------------
    // Reward accrual
    // ---------------------------------------------------------------------

    function test_PendingPeg_ZeroBeforeStart() public {
        vm.prank(owner);
        pool.add(100, IERC20(address(lp)), false, 0);
        _stake(alice, 0, 100 ether);
        // Before poolStart: no rewards.
        assertEq(pool.pendingPeg(0, alice), 0);
    }

    function test_PendingPeg_AccruesAtRate() public {
        vm.prank(owner);
        pool.add(100, IERC20(address(lp)), false, 0);
        _stake(alice, 0, 100 ether);

        // Jump to halfway through the pool window.
        vm.warp(poolStart + 12 hours);
        uint256 expected = 12 hours * pool.PEG_PER_SECOND();
        // Alice is the sole staker → she gets the full emission.
        assertApproxEqAbs(pool.pendingPeg(0, alice), expected, 1);
    }

    function test_PendingPeg_SplitProRata() public {
        vm.prank(owner);
        pool.add(100, IERC20(address(lp)), false, 0);
        _stake(alice, 0, 100 ether);
        _stake(bob, 0, 300 ether);

        vm.warp(poolStart + 12 hours);
        // alice has 25% of total stake, bob has 75%.
        uint256 totalAtTime = 12 hours * pool.PEG_PER_SECOND();
        assertApproxEqRel(pool.pendingPeg(0, alice), totalAtTime / 4, 0.001e18);
        assertApproxEqRel(pool.pendingPeg(0, bob), totalAtTime * 3 / 4, 0.001e18);
    }

    function test_PendingPeg_CapsAtPoolEnd() public {
        vm.prank(owner);
        pool.add(100, IERC20(address(lp)), false, 0);
        _stake(alice, 0, 100 ether);

        // Past poolEnd by 1 day.
        vm.warp(poolStart + 2 days);
        uint256 expected = pool.RUNNING_TIME() * pool.PEG_PER_SECOND();
        assertApproxEqAbs(pool.pendingPeg(0, alice), expected, 1);

        // Even further past — same total.
        vm.warp(poolStart + 30 days);
        assertApproxEqAbs(pool.pendingPeg(0, alice), expected, 1);
    }

    // ---------------------------------------------------------------------
    // Deposit / withdraw / claim
    // ---------------------------------------------------------------------

    function test_Withdraw_RejectsOverAmount() public {
        vm.prank(owner);
        pool.add(100, IERC20(address(lp)), false, 0);
        _stake(alice, 0, 100 ether);
        vm.prank(alice);
        vm.expectRevert(GenesisRewardPool.WithdrawAmountTooHigh.selector);
        pool.withdraw(0, 101 ether);
    }

    function test_Withdraw_ReturnsLpAndPaysRewards() public {
        vm.prank(owner);
        pool.add(100, IERC20(address(lp)), false, 0);
        _stake(alice, 0, 100 ether);

        vm.warp(poolStart + 6 hours);
        uint256 expectedReward = 6 hours * pool.PEG_PER_SECOND();

        uint256 lpBefore = lp.balanceOf(alice);
        uint256 pegBefore = peg.balanceOf(alice);

        vm.prank(alice);
        pool.withdraw(0, 40 ether);

        assertEq(lp.balanceOf(alice), lpBefore + 40 ether);
        assertApproxEqAbs(peg.balanceOf(alice) - pegBefore, expectedReward, 1);
    }

    function test_EmergencyWithdraw_ReturnsLpDropsRewards() public {
        vm.prank(owner);
        pool.add(100, IERC20(address(lp)), false, 0);
        _stake(alice, 0, 100 ether);

        vm.warp(poolStart + 6 hours);
        uint256 pegBefore = peg.balanceOf(alice);

        vm.prank(alice);
        pool.emergencyWithdraw(0);

        assertEq(lp.balanceOf(alice), 100 ether);
        // Rewards forfeited.
        assertEq(peg.balanceOf(alice), pegBefore);
        // Stake cleared.
        (uint256 amount, uint256 rewardDebt) = pool.userInfo(0, alice);
        assertEq(amount, 0);
        assertEq(rewardDebt, 0);
    }

    // ---------------------------------------------------------------------
    // Multi-pool allocation
    // ---------------------------------------------------------------------

    function test_MultiPool_SplitsByAllocPoint() public {
        vm.prank(owner);
        pool.add(100, IERC20(address(lp)), false, 0);
        vm.prank(owner);
        pool.add(300, IERC20(address(lp2)), false, 0);

        _stake(alice, 0, 100 ether); // pool 0
        _stake(bob, 1, 100 ether); // pool 1

        vm.warp(poolStart + 12 hours);
        uint256 totalAtTime = 12 hours * pool.PEG_PER_SECOND();
        // alice's pool has alloc 100/400 = 25%, bob's pool 300/400 = 75%.
        assertApproxEqRel(pool.pendingPeg(0, alice), totalAtTime / 4, 0.001e18);
        assertApproxEqRel(pool.pendingPeg(1, bob), totalAtTime * 3 / 4, 0.001e18);
    }

    // ---------------------------------------------------------------------
    // governanceRecoverUnsupported
    // ---------------------------------------------------------------------

    function test_GovernanceRecover_OnlyOperator() public {
        vm.prank(stranger);
        vm.expectRevert(GenesisRewardPool.NotOperator.selector);
        pool.governanceRecoverUnsupported(IERC20(address(peg)), 1, alice);
    }

    function test_GovernanceRecover_ProtectsCoreInsideWindow() public {
        vm.prank(owner);
        vm.expectRevert(GenesisRewardPool.ProtectedToken.selector);
        pool.governanceRecoverUnsupported(IERC20(address(peg)), 1, alice);
    }

    function test_GovernanceRecover_ProtectsStakedLpInsideWindow() public {
        vm.prank(owner);
        pool.add(100, IERC20(address(lp)), false, 0);

        vm.prank(owner);
        vm.expectRevert(GenesisRewardPool.ProtectedToken.selector);
        pool.governanceRecoverUnsupported(IERC20(address(lp)), 1, alice);
    }

    function test_GovernanceRecover_AllowsArbitraryTokenInsideWindow() public {
        MockLp rando = new MockLp("Random", "RAND");
        rando.mint(address(pool), 100 ether);

        vm.prank(owner);
        pool.governanceRecoverUnsupported(IERC20(address(rando)), 100 ether, alice);
        assertEq(rando.balanceOf(alice), 100 ether);
    }

    function test_GovernanceRecover_AllowsCoreTokenAfterWindow() public {
        vm.warp(poolStart + 1 days + 90 days + 1);
        uint256 dust = peg.balanceOf(address(pool));
        vm.prank(owner);
        pool.governanceRecoverUnsupported(IERC20(address(peg)), dust, alice);
        assertEq(peg.balanceOf(alice), dust);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _stake(
        address who,
        uint256 pid,
        uint256 amount
    ) internal {
        MockLp token = pid == 0 ? lp : lp2;
        token.mint(who, amount);
        vm.prank(who);
        token.approve(address(pool), amount);
        vm.prank(who);
        pool.deposit(pid, amount);
    }
}
