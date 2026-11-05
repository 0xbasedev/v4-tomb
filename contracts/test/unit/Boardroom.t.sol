// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";

import {Boardroom} from "../../src/core/Boardroom.sol";
import {PegToken} from "../../src/tokens/PegToken.sol";
import {ShareToken, ShareTokenProfiles} from "../../src/tokens/ShareToken.sol";
import {Trustees} from "../../src/governance/Trustees.sol";
import {ITreasury} from "../../src/interfaces/ITreasury.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal ITreasury stand-in: only exposes the epoch and price views Boardroom
///         calls into. Tests drive its state directly via setters.
contract MockTreasury is ITreasury {
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

contract BoardroomTest is BaseTest {
    Boardroom internal boardroom;
    PegToken internal money;
    ShareToken internal estate;
    MockTreasury internal treasuryMock;

    address internal communityFund = makeAddr("communityFund");
    address internal devFund = makeAddr("devFund");
    address internal farmingPool = makeAddr("farmingPool");

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardAdded(address indexed user, uint256 reward);

    function setUp() public override {
        super.setUp();
        vm.label(communityFund, "communityFund");
        vm.label(devFund, "devFund");

        vm.warp(1_700_000_000);

        // Deploy tokens with owner as initial trustees.
        vm.prank(owner);
        money = new PegToken(owner);
        vm.prank(owner);
        estate = new ShareToken(ShareTokenProfiles.legacy(block.timestamp, communityFund, devFund, owner), owner);

        treasuryMock = new MockTreasury();
        treasuryMock.setStartTime(block.timestamp);

        vm.prank(owner);
        boardroom = new Boardroom(owner);
        vm.prank(owner);
        boardroom.initialize(IERC20(address(money)), IERC20(address(estate)), ITreasury(address(treasuryMock)));

        // Hand off mint authority on MONEY to a controllable address so this test can
        // mint MONEY directly for testing reward flows.
        vm.prank(owner);
        money.transferTrustees(address(this)); // test contract becomes trustees

        // Materialize ShareToken supply via distributeReward, then fund alice and bob.
        vm.prank(owner);
        estate.distributeReward(farmingPool);
        vm.prank(farmingPool);
        estate.transfer(alice, 100 ether);
        vm.prank(farmingPool);
        estate.transfer(bob, 50 ether);
    }

    // ---------------------------------------------------------------------
    // Initialize
    // ---------------------------------------------------------------------

    function test_Initialize_StoresParams() public view {
        assertEq(address(boardroom.money()), address(money));
        assertEq(address(boardroom.share()), address(estate));
        assertEq(address(boardroom.treasury()), address(treasuryMock));
        assertEq(boardroom.operator(), owner);
        assertTrue(boardroom.initialized());
        assertEq(boardroom.withdrawLockupEpochs(), 6);
        assertEq(boardroom.rewardLockupEpochs(), 3);
    }

    function test_Initialize_OneShot() public {
        vm.prank(owner);
        vm.expectRevert(Boardroom.AlreadyInitialized.selector);
        boardroom.initialize(IERC20(address(money)), IERC20(address(estate)), ITreasury(address(treasuryMock)));
    }

    // ---------------------------------------------------------------------
    // Stake
    // ---------------------------------------------------------------------

    function test_Stake_RecordsBalance() public {
        vm.prank(alice);
        estate.approve(address(boardroom), 10 ether);

        vm.expectEmit(true, true, true, true);
        emit Staked(alice, 10 ether);
        vm.prank(alice);
        boardroom.stake(10 ether);

        assertEq(boardroom.balanceOf(alice), 10 ether);
        assertEq(boardroom.totalSupply(), 10 ether);
        assertEq(estate.balanceOf(address(boardroom)), 10 ether);
    }

    function test_Stake_RejectsZero() public {
        vm.prank(alice);
        vm.expectRevert(Boardroom.CannotStakeZero.selector);
        boardroom.stake(0);
    }

    function test_Stake_StartsEpochTimer() public {
        treasuryMock.setEpoch(5);
        _stakeAlice(10 ether);
        (,, uint256 epochTimerStart) = boardroom.members(alice);
        assertEq(epochTimerStart, 5);
    }

    // ---------------------------------------------------------------------
    // Withdraw / lockup
    // ---------------------------------------------------------------------

    function test_Withdraw_BlockedDuringLockup() public {
        _stakeAlice(10 ether);

        // withdrawLockupEpochs = 6, epoch starts at 0, withdraw fails until epoch >= 6.
        treasuryMock.setEpoch(5);
        vm.roll(block.number + 1);
        vm.prank(alice);
        vm.expectRevert(Boardroom.InWithdrawLockup.selector);
        boardroom.withdraw(5 ether);
    }

    function test_Withdraw_AllowedAfterLockup() public {
        _stakeAlice(10 ether);
        treasuryMock.setEpoch(6); // lockup passes (epochTimerStart=0, +6 == 6)
        vm.roll(block.number + 1);

        vm.expectEmit(true, true, true, true);
        emit Withdrawn(alice, 4 ether);
        vm.prank(alice);
        boardroom.withdraw(4 ether);

        assertEq(boardroom.balanceOf(alice), 6 ether);
        assertEq(estate.balanceOf(alice), 100 ether - 6 ether); // started at 100, staked 10, withdrew 4
    }

    function test_Withdraw_RequiresMembership() public {
        treasuryMock.setEpoch(10);
        vm.prank(stranger);
        vm.expectRevert(Boardroom.MemberDoesNotExist.selector);
        boardroom.withdraw(1 ether);
    }

    function test_Exit_WithdrawsAllAndClaims() public {
        _stakeAlice(10 ether);

        // Operator allocates 1 MONEY as reward. Move past reward lockup.
        _allocateReward(1 ether);
        treasuryMock.setEpoch(6);
        vm.roll(block.number + 1);

        vm.prank(alice);
        boardroom.exit();
        assertEq(boardroom.balanceOf(alice), 0);
        assertEq(money.balanceOf(alice), 1 ether); // got the full reward (sole staker)
    }

    // ---------------------------------------------------------------------
    // allocateSeigniorage + claimReward
    // ---------------------------------------------------------------------

    function test_AllocateSeigniorage_OnlyOperator() public {
        _stakeAlice(10 ether);
        money.mint(stranger, 1 ether); // this test contract is currently trustees
        vm.prank(stranger);
        money.approve(address(boardroom), 1 ether);
        vm.roll(block.number + 1); // dodge onlyOneBlock
        vm.prank(stranger);
        vm.expectRevert(Boardroom.NotOperator.selector);
        boardroom.allocateSeigniorage(1 ether);
    }

    function test_AllocateSeigniorage_RejectsZero() public {
        _stakeAlice(10 ether);
        vm.roll(block.number + 1);
        vm.prank(owner);
        vm.expectRevert(Boardroom.CannotAllocateZero.selector);
        boardroom.allocateSeigniorage(0);
    }

    function test_AllocateSeigniorage_RejectsEmptyPool() public {
        money.mint(owner, 1 ether);
        vm.prank(owner);
        money.approve(address(boardroom), 1 ether);
        vm.prank(owner);
        vm.expectRevert(Boardroom.CannotAllocateWhenTotalSupplyZero.selector);
        boardroom.allocateSeigniorage(1 ether);
    }

    function test_AllocateSeigniorage_DistributesProRata() public {
        _stakeAlice(10 ether);
        _stakeBob(30 ether);

        // Owner (operator) allocates 4 MONEY. Alice = 25%, bob = 75%.
        _allocateReward(4 ether);

        // earned() is what each member can claim.
        assertApproxEqAbs(boardroom.earned(alice), 1 ether, 1);
        assertApproxEqAbs(boardroom.earned(bob), 3 ether, 1);
    }

    function test_ClaimReward_BlockedDuringRewardLockup() public {
        _stakeAlice(10 ether);
        _allocateReward(1 ether);
        // rewardLockupEpochs = 3. epoch starts at 0. Lockup passes at epoch 3.
        treasuryMock.setEpoch(2);
        vm.prank(alice);
        vm.expectRevert(bytes("Boardroom: still in reward lockup"));
        boardroom.claimReward();
    }

    function test_ClaimReward_AllowedAfterLockup() public {
        _stakeAlice(10 ether);
        _allocateReward(1 ether);
        treasuryMock.setEpoch(3);

        vm.expectEmit(true, true, true, true);
        emit RewardPaid(alice, 1 ether);
        vm.prank(alice);
        boardroom.claimReward();
        assertEq(money.balanceOf(alice), 1 ether);
    }

    function test_ClaimReward_NoopWhenZero() public {
        _stakeAlice(10 ether);
        treasuryMock.setEpoch(3);
        // No reward allocated. claimReward should be a silent no-op.
        vm.prank(alice);
        boardroom.claimReward();
        assertEq(money.balanceOf(alice), 0);
    }

    // ---------------------------------------------------------------------
    // setLockUp governance
    // ---------------------------------------------------------------------

    function test_SetLockUp_OnlyOperator() public {
        vm.prank(stranger);
        vm.expectRevert(Boardroom.NotOperator.selector);
        boardroom.setLockUp(10, 5);
    }

    function test_SetLockUp_RejectsWithdrawLessThanReward() public {
        vm.prank(owner);
        vm.expectRevert(Boardroom.LockupOutOfRange.selector);
        boardroom.setLockUp(2, 5);
    }

    function test_SetLockUp_RejectsAboveCeiling() public {
        vm.prank(owner);
        vm.expectRevert(Boardroom.LockupOutOfRange.selector);
        boardroom.setLockUp(57, 3);
    }

    function test_SetLockUp_UpdatesValues() public {
        vm.prank(owner);
        boardroom.setLockUp(10, 5);
        assertEq(boardroom.withdrawLockupEpochs(), 10);
        assertEq(boardroom.rewardLockupEpochs(), 5);
    }

    // ---------------------------------------------------------------------
    // governanceRecoverUnsupported
    // ---------------------------------------------------------------------

    function test_GovernanceRecoverUnsupported_BlocksMoney() public {
        vm.prank(owner);
        vm.expectRevert(Boardroom.ProtectedToken.selector);
        boardroom.governanceRecoverUnsupported(IERC20(address(money)), 1, alice);
    }

    function test_GovernanceRecoverUnsupported_BlocksShare() public {
        vm.prank(owner);
        vm.expectRevert(Boardroom.ProtectedToken.selector);
        boardroom.governanceRecoverUnsupported(IERC20(address(estate)), 1, alice);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _stakeAlice(
        uint256 amount
    ) internal {
        vm.prank(alice);
        estate.approve(address(boardroom), amount);
        vm.prank(alice);
        boardroom.stake(amount);
    }

    function _stakeBob(
        uint256 amount
    ) internal {
        vm.prank(bob);
        estate.approve(address(boardroom), amount);
        vm.roll(block.number + 1); // dodge onlyOneBlock if alice and bob both staked
        vm.prank(bob);
        boardroom.stake(amount);
    }

    function _allocateReward(
        uint256 amount
    ) internal {
        // This test contract is the MONEY trustees (set in setUp); mint MONEY to owner.
        money.mint(owner, amount);
        vm.prank(owner);
        money.approve(address(boardroom), amount);
        vm.roll(block.number + 1);
        vm.prank(owner);
        boardroom.allocateSeigniorage(amount);
    }
}
