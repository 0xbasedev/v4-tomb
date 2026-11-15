// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";

import {Boardroom} from "../../src/core/Boardroom.sol";
import {ShareRewardPool} from "../../src/distribution/ShareRewardPool.sol";
import {ITreasury} from "../../src/interfaces/ITreasury.sol";
import {ShareToken} from "../../src/tokens/ShareToken.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract BoostMockLp is ERC20 {
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

/// @notice Minimal ITreasury stand-in (same shape as Boardroom.t.sol's
///         mock): tests drive the epoch directly, synced to warped time.
contract BoostMockTreasury is ITreasury {
    uint256 public epoch_;
    uint256 public price = 1e18;
    uint256 public period = 6 hours;
    uint256 public startTime;

    function setEpoch(
        uint256 e
    ) external {
        epoch_ = e;
    }

    function setStartTime(
        uint256 t
    ) external {
        startTime = t;
    }

    function epoch() external view returns (uint256) {
        return epoch_;
    }

    function nextEpochPoint() external view returns (uint256) {
        return startTime + epoch_ * period;
    }

    function getMoneyPrice() external view returns (uint256) {
        return price;
    }

    function buyBonds(
        uint256,
        uint256
    ) external pure {}
    function redeemBonds(
        uint256,
        uint256
    ) external pure {}
}

/// @notice Weekly loyalty boost (specs.md §8/§18): the farms' 5% xSHARE
///         carve-out — baked in at deploy — paid pro-rata to users who held
///         stake in the MASONRY (Boardroom) for a whole week with zero
///         Masonry LP withdrawals. Farm-pool stake alone never qualifies
///         (Jess, 2026-11-09: "just masonry boost").
contract ShareRewardPoolWeeklyBoostTest is BaseTest {
    ShareRewardPool internal pool;
    Boardroom internal boardroom;
    ShareToken internal estate;
    BoostMockLp internal lpA; // xTOMB LP (farm pool 0, alloc 75)
    BoostMockLp internal lpB; // xSHARE LP (farm pool 1, alloc 20)
    BoostMockLp internal money;
    BoostMockTreasury internal treasury;

    address internal communityFund = makeAddr("communityFund");
    address internal devFund = makeAddr("devFund");
    address internal farmingPool = makeAddr("farmingPool");

    uint256 internal t0;
    uint256 internal poolStart;
    uint256 internal constant TOL = 1e8; // wei dust from segmented floor division

    function setUp() public override {
        super.setUp();
        t0 = 1_700_000_000;
        vm.warp(t0);
        poolStart = t0 + 1 hours;

        vm.prank(owner);
        estate = new ShareToken(t0, communityFund, devFund, owner);

        vm.prank(owner);
        pool = new ShareRewardPool(address(estate), poolStart, owner);

        money = new BoostMockLp("Money", "MONEY");
        treasury = new BoostMockTreasury();
        treasury.setStartTime(t0);

        vm.prank(owner);
        boardroom = new Boardroom(owner);
        vm.prank(owner);
        boardroom.initialize(IERC20(address(money)), IERC20(address(estate)), ITreasury(address(treasury)));

        // Wire the boost to the Masonry both ways, before any staking.
        vm.prank(owner);
        boardroom.setLoyaltyTracker(address(pool));
        vm.prank(owner);
        pool.setMasonryBoardroom(address(boardroom));

        lpA = new BoostMockLp("xTOMB LP", "LP-A");
        lpB = new BoostMockLp("xSHARE LP", "LP-B");

        vm.prank(owner);
        estate.distributeReward(farmingPool);
        // Cover for boost claims: a week's bucket is ~56 ether of xSHARE.
        vm.prank(farmingPool);
        estate.transfer(address(pool), 5_000 ether);
        // Users' Masonry stake funds (the Boardroom stakes the share token).
        vm.startPrank(farmingPool);
        estate.transfer(alice, 2_000 ether);
        estate.transfer(bob, 2_000 ether);
        estate.transfer(carol, 2_000 ether);
        vm.stopPrank();

        vm.startPrank(owner);
        pool.add(75, IERC20(address(lpA)), false, 0);
        pool.add(20, IERC20(address(lpB)), false, 0);
        vm.stopPrank();
        // No setBoostPercent call: the 5% is the deploy default (ruling 1).
    }

    // ---- helpers ----

    function _syncEpoch() internal {
        treasury.setEpoch((block.timestamp - t0) / 6 hours);
    }

    function _warp(
        uint256 t
    ) internal {
        vm.warp(t);
        _syncEpoch();
    }

    /// @dev Boardroom actions roll a block first: its onlyOneBlock guard
    ///      keys on origin + sender per block.
    function _mStake(
        address user,
        uint256 amount
    ) internal {
        vm.roll(block.number + 1);
        vm.startPrank(user);
        estate.approve(address(boardroom), amount);
        boardroom.stake(amount);
        vm.stopPrank();
    }

    function _mWithdraw(
        address user,
        uint256 amount
    ) internal {
        vm.roll(block.number + 1);
        vm.prank(user);
        boardroom.withdraw(amount);
    }

    function _fStake(
        address user,
        uint256 pid,
        BoostMockLp lp,
        uint256 amount
    ) internal {
        lp.mint(user, amount);
        vm.startPrank(user);
        lp.approve(address(pool), amount);
        pool.deposit(pid, amount);
        vm.stopPrank();
    }

    function _claimDelta(
        address user
    ) internal returns (uint256) {
        uint256 before = estate.balanceOf(user);
        vm.prank(user);
        pool.claimBoost();
        return estate.balanceOf(user) - before;
    }

    function _weekEmission() internal view returns (uint256) {
        return pool.SHARE_PER_SECOND() * 7 days;
    }

    // ---- (a) emission split exactness (funding side, unchanged) ----

    function testBoost_EmissionSplit_Exact75_20_5() public {
        _fStake(alice, 0, lpA, 100 ether);
        _fStake(bob, 1, lpB, 100 ether);
        // An eligible Masonry staker for week 0, so its bucket stays in
        // week 0 instead of rolling forward (zero-eligible weeks roll).
        _mStake(carol, 100 ether);

        _warp(poolStart + 7 days + 1 hours);
        pool.massUpdatePools();

        uint256 elapsedGen = pool.SHARE_PER_SECOND() * (7 days + 1 hours);
        assertApproxEqAbs(pool.pendingShare(0, alice), elapsedGen * 75 / 100, TOL);
        assertApproxEqAbs(pool.pendingShare(1, bob), elapsedGen * 20 / 100, TOL);
        assertApproxEqAbs(pool.weekBoost(0), _weekEmission() * 5 / 100, TOL);
        // Conservation: pools + both weekly buckets account for the emission
        // (the stray hour past the boundary sits in week 1's bucket).
        uint256 accounted = pool.pendingShare(0, alice) + pool.pendingShare(1, bob) + pool.weekBoost(0) + pool.weekBoost(1);
        assertApproxEqAbs(accounted, elapsedGen, TOL);
    }

    // ---- (b) full-week Masonry staker receives their pro-rata share ----

    function testBoost_FullWeekMasonryStaker_ReceivesProRataShare() public {
        _mStake(alice, 100 ether);

        _warp(poolStart + 7 days + 1 hours);
        uint256 got = _claimDelta(alice);
        assertApproxEqAbs(got, _weekEmission() * 5 / 100, TOL);

        // Pull-based and settled: a second claim pays nothing more.
        assertEq(pool.pendingBoost(alice), 0);
        assertEq(_claimDelta(alice), 0);
    }

    // ---- (c) any mid-week Masonry LP withdrawal voids the week ----

    function testBoost_MidWeekMasonryWithdrawal_ReceivesNothing() public {
        _mStake(alice, 100 ether);

        _warp(poolStart + 3 days);
        _mWithdraw(alice, 1); // a single wei of Masonry stake out is enough
        assertEq(pool.lastLpWithdrawalAt(alice), poolStart + 3 days);

        _warp(poolStart + 7 days + 1 hours);
        assertEq(pool.pendingBoost(alice), 0);
        assertEq(_claimDelta(alice), 0);
    }

    // ---- (d) mid-week Masonry entrant earns nothing for the partial week ----

    function testBoost_MidWeekMasonryEntrant_ReceivesNothingForPartialWeek() public {
        // Alice is in from before the start, so week 0 has an eligible
        // staker and its boost does not roll forward into bob's weeks.
        _mStake(alice, 100 ether);

        _warp(poolStart + 3 days);
        _mStake(bob, 100 ether);

        _warp(poolStart + 7 days + 1 hours);
        assertEq(_claimDelta(bob), 0);
        assertTrue(_claimDelta(alice) > 0); // week 0 paid its eligible staker

        // The next full week counts for bob: in at its start, no withdrawals.
        // Equal Masonry stakes (100 each) split week 1's boost evenly.
        _warp(poolStart + 14 days + 1 hours);
        uint256 got = _claimDelta(bob);
        assertApproxEqAbs(got, _weekEmission() * 5 / 100 / 2, TOL);
    }

    // ---- (e) two eligible Masonry stakers split pro-rata to stake ----

    function testBoost_TwoEligibleMasonryStakers_SplitProRataToStake() public {
        _mStake(alice, 300 ether);
        _mStake(bob, 100 ether);

        _warp(poolStart + 7 days + 1 hours);
        uint256 aliceGot = _claimDelta(alice);
        uint256 bobGot = _claimDelta(bob);

        uint256 weekBoost = _weekEmission() * 5 / 100;
        assertApproxEqAbs(aliceGot, weekBoost * 3 / 4, TOL);
        assertApproxEqAbs(bobGot, weekBoost / 4, TOL);
        assertApproxEqAbs(aliceGot + bobGot, weekBoost, TOL);
    }

    // ---- top-ups mid-week: only the start-of-week Masonry stake counts ----

    function testBoost_MidWeekMasonryTopUp_OnlyStartOfWeekStakeCounts() public {
        _mStake(alice, 100 ether);
        _mStake(bob, 100 ether);

        _warp(poolStart + 3 days);
        _mStake(alice, 900 ether); // flush mid-week: must not dilute bob

        _warp(poolStart + 7 days + 1 hours);
        uint256 aliceGot = _claimDelta(alice);
        uint256 bobGot = _claimDelta(bob);
        assertApproxEqAbs(aliceGot, bobGot, TOL);
        assertApproxEqAbs(aliceGot + bobGot, _weekEmission() * 5 / 100, TOL);
    }

    // ---- farm-only stake never qualifies (ruling 2) ----

    function testBoost_FarmOnlyStake_EarnsNothing() public {
        _mStake(alice, 100 ether); // Masonry stake: eligible
        _fStake(carol, 0, lpA, 100 ether); // farm stake only, held all week

        _warp(poolStart + 7 days + 1 hours);
        pool.massUpdatePools();

        // Carol does not dilute week 0: its eligible total is alice's
        // Masonry stake alone, and alice takes the whole bucket.
        assertEq(pool.weekEligibleTotal(0), 100 ether);
        assertEq(pool.pendingBoost(carol), 0);
        assertEq(_claimDelta(carol), 0);
        assertApproxEqAbs(_claimDelta(alice), _weekEmission() * 5 / 100, TOL);

        // A farm withdrawal does not move the loyalty clock either.
        _warp(poolStart + 8 days);
        vm.prank(carol);
        pool.withdraw(0, 1);
        assertEq(pool.lastLpWithdrawalAt(carol), 0);
    }

    // ---- (f) config / admin surface ----

    function testBoost_AdminSurface_SettersValidatedAndOwnerOnly() public {
        assertEq(pool.weekLength(), 7 days);
        assertEq(pool.boostPercent(), 5); // baked in at deploy (ruling 1)
        assertEq(pool.masonryBoardroom(), address(boardroom));

        vm.prank(alice);
        vm.expectRevert(ShareRewardPool.NotOperator.selector);
        pool.setBoostPercent(7);

        vm.prank(owner);
        vm.expectRevert(ShareRewardPool.InvalidBoostPercent.selector);
        pool.setBoostPercent(26);

        vm.expectEmit(true, true, true, true);
        emit ShareRewardPool.BoostPercentSet(10);
        vm.prank(owner);
        pool.setBoostPercent(10);
        assertEq(pool.boostPercent(), 10);
        vm.prank(owner);
        pool.setBoostPercent(5);

        // Week length: invalid values rejected while still pre-start...
        vm.prank(owner);
        vm.expectRevert(ShareRewardPool.InvalidWeekLength.selector);
        pool.setWeekLength(0);
        vm.prank(owner);
        vm.expectRevert(ShareRewardPool.InvalidWeekLength.selector);
        pool.setWeekLength(31 days);
        vm.prank(owner);
        pool.setWeekLength(14 days);
        assertEq(pool.weekLength(), 14 days);

        // ...and locked forever once the farm has started.
        _warp(poolStart + 1 hours);
        vm.prank(owner);
        vm.expectRevert(ShareRewardPool.WeekLengthLocked.selector);
        pool.setWeekLength(7 days);
    }

    function testBoost_MasonryWiring_OwnerOnlyAndHookGated() public {
        // Re-pointing the Masonry is operator-only...
        vm.prank(alice);
        vm.expectRevert(ShareRewardPool.NotOperator.selector);
        pool.setMasonryBoardroom(address(0xBEEF));

        // ...the Boardroom's tracker setter is operator-only...
        vm.prank(stranger);
        vm.expectRevert(Boardroom.NotOperator.selector);
        boardroom.setLoyaltyTracker(address(0xBEEF));

        // ...and the hook itself rejects anyone but the wired Boardroom.
        vm.prank(alice);
        vm.expectRevert(ShareRewardPool.NotMasonryBoardroom.selector);
        pool.onMasonryStakeChange(alice, false, 1 ether);
    }

    // ---- (g) a week with zero eligible stakers rolls forward ----

    function testBoost_ZeroEligibleWeek_RollsForwardNoLossNoLockup() public {
        _mStake(alice, 100 ether);

        // Dirty week 0: alice is the only Masonry staker and withdraws
        // mid-week.
        _warp(poolStart + 3 days);
        _mWithdraw(alice, 1);

        // Close week 0: nobody was eligible, the bucket must not strand.
        _warp(poolStart + 7 days + 1 hours);
        pool.massUpdatePools();
        assertEq(pool.weekEligibleTotal(0), 0);
        assertEq(pool.weekBoost(0), 0); // rolled into week 1's bucket

        // Alice stood clean through week 1 with her remaining stake, so the
        // rolled-forward week-0 boost reaches her with week 1's — two weeks
        // of boost, nothing lost, nothing locked.
        _warp(poolStart + 14 days + 1 hours);
        uint256 got = _claimDelta(alice);
        assertApproxEqAbs(got, _weekEmission() * 2 * 5 / 100, TOL);
        // Total accrual runs to the current timestamp: two full weeks of
        // boost plus the stray hour of week 2 that has accrued so far.
        assertApproxEqAbs(pool.totalBoostAccrued(), pool.SHARE_PER_SECOND() * (14 days + 1 hours) * 5 / 100, TOL);
    }
}
