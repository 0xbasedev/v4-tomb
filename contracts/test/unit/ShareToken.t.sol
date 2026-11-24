// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";
import {ShareToken} from "../../src/tokens/ShareToken.sol";
import {Trustees} from "../../src/governance/Trustees.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract ShareTokenTest is BaseTest {
    ShareToken internal share;

    address internal communityFund = makeAddr("communityFund");
    address internal devFund = makeAddr("devFund");
    address internal farmingFund = makeAddr("farmingFund");

    uint256 internal vestingStart;

    event RewardPoolDistributed(address indexed farmingIncentiveFund);
    event CommunityFundUpdated(address indexed previous, address indexed next);
    event DevFundUpdated(address indexed previous, address indexed next);

    function setUp() public override {
        super.setUp();
        vm.label(communityFund, "communityFund");
        vm.label(devFund, "devFund");
        vm.label(farmingFund, "farmingFund");

        vestingStart = block.timestamp + 1 hours;

        vm.prank(owner);
        share = new ShareToken("Share Token", "SHARE", vestingStart, communityFund, devFund);

        // Rotate trustees from `owner` (the deployer default) to the dedicated `trustees` actor.
        vm.prank(owner);
        share.transferTrustees(trustees);
    }

    // ---------------------------------------------------------------------
    // Constructor / metadata
    // ---------------------------------------------------------------------

    function test_Metadata() public view {
        assertEq(share.name(), "Share Token");
        assertEq(share.symbol(), "SHARE");
        assertEq(share.decimals(), 18);
    }

    function test_Constants() public view {
        assertEq(share.FARMING_POOL_REWARD_ALLOCATION(), 59_500 ether);
        assertEq(share.COMMUNITY_FUND_POOL_ALLOCATION(), 5500 ether);
        assertEq(share.DEV_FUND_POOL_ALLOCATION(), 5000 ether);
        assertEq(share.VESTING_DURATION(), 365 days);
    }

    function test_ConstantsSumToTombMaxSupply() public view {
        // Tomb canonical: 70,000 TSHARE max supply (59,500 + 5,500 + 5,000).
        assertEq(
            share.FARMING_POOL_REWARD_ALLOCATION() + share.COMMUNITY_FUND_POOL_ALLOCATION()
                + share.DEV_FUND_POOL_ALLOCATION(),
            70_000 ether
        );
    }

    function test_Constructor_InitialState() public view {
        // 1 ether minted to the deployer.
        assertEq(share.balanceOf(owner), 1 ether);
        assertEq(share.totalSupply(), 1 ether);

        assertEq(share.startTime(), vestingStart);
        assertEq(share.endTime(), vestingStart + 365 days);
        assertEq(share.communityFund(), communityFund);
        assertEq(share.devFund(), devFund);
        assertEq(share.communityFundLastClaimed(), vestingStart);
        assertEq(share.devFundLastClaimed(), vestingStart);

        // Vesting rates are alloc / duration.
        assertEq(share.communityFundRewardRate(), uint256(5500 ether) / 365 days);
        assertEq(share.devFundRewardRate(), uint256(5000 ether) / 365 days);
    }

    function test_Constructor_RejectsZeroCommunityFund() public {
        vm.prank(owner);
        vm.expectRevert(ShareToken.ZeroAddress.selector);
        new ShareToken("Share Token", "SHARE", vestingStart, address(0), devFund);
    }

    function test_Constructor_RejectsZeroDevFund() public {
        vm.prank(owner);
        vm.expectRevert(ShareToken.ZeroAddress.selector);
        new ShareToken("Share Token", "SHARE", vestingStart, communityFund, address(0));
    }

    // ---------------------------------------------------------------------
    // setTreasuryFund / setDevFund — Tomb's devFund-controlled rotation quirk
    // ---------------------------------------------------------------------

    function test_SetTreasuryFund_OnlyDevFund() public {
        vm.prank(owner);
        vm.expectRevert(ShareToken.NotDevFund.selector);
        share.setTreasuryFund(alice);

        vm.prank(stranger);
        vm.expectRevert(ShareToken.NotDevFund.selector);
        share.setTreasuryFund(alice);
    }

    function test_SetTreasuryFund_RejectsZero() public {
        vm.prank(devFund);
        vm.expectRevert(ShareToken.ZeroAddress.selector);
        share.setTreasuryFund(address(0));
    }

    function test_SetTreasuryFund_Rotates() public {
        vm.expectEmit(true, true, true, true);
        emit CommunityFundUpdated(communityFund, alice);
        vm.prank(devFund);
        share.setTreasuryFund(alice);
        assertEq(share.communityFund(), alice);
    }

    function test_SetDevFund_OnlyDevFund() public {
        vm.prank(owner);
        vm.expectRevert(ShareToken.NotDevFund.selector);
        share.setDevFund(alice);
    }

    function test_SetDevFund_RejectsZero() public {
        vm.prank(devFund);
        vm.expectRevert(ShareToken.ZeroAddress.selector);
        share.setDevFund(address(0));
    }

    function test_SetDevFund_Rotates() public {
        vm.expectEmit(true, true, true, true);
        emit DevFundUpdated(devFund, alice);
        vm.prank(devFund);
        share.setDevFund(alice);
        assertEq(share.devFund(), alice);
    }

    // ---------------------------------------------------------------------
    // Linear vesting math (claimRewards)
    // ---------------------------------------------------------------------

    function test_Vesting_NothingClaimableBeforeStart() public view {
        // We're currently before vestingStart.
        assertLt(block.timestamp, vestingStart);
        assertEq(share.unclaimedTreasuryFund(), 0);
        assertEq(share.unclaimedDevFund(), 0);
    }

    function test_Vesting_HalfwayThrough() public {
        // Jump to vestingStart + 6 months.
        vm.warp(vestingStart + 182.5 days);

        uint256 communityRate = share.communityFundRewardRate();
        uint256 devRate = share.devFundRewardRate();
        uint256 expectedCommunity = uint256(182.5 days) * communityRate;
        uint256 expectedDev = uint256(182.5 days) * devRate;

        assertEq(share.unclaimedTreasuryFund(), expectedCommunity);
        assertEq(share.unclaimedDevFund(), expectedDev);
    }

    function test_Vesting_FullyClaimableAtEnd() public {
        vm.warp(vestingStart + 365 days);

        uint256 expectedCommunity = uint256(365 days) * share.communityFundRewardRate();
        uint256 expectedDev = uint256(365 days) * share.devFundRewardRate();

        assertEq(share.unclaimedTreasuryFund(), expectedCommunity);
        assertEq(share.unclaimedDevFund(), expectedDev);

        // Tomb integer-division rounding leaves a tiny residual under the nominal alloc.
        // The residual is < VESTING_DURATION (in wei).
        assertGt(expectedCommunity, 5500 ether - 365 days);
        assertLe(expectedCommunity, 5500 ether);
        assertGt(expectedDev, 5000 ether - 365 days);
        assertLe(expectedDev, 5000 ether);
    }

    function test_Vesting_CapsAtEndTime() public {
        // Way past the end. Should still cap at endTime worth of accrual.
        vm.warp(vestingStart + 365 days + 100 days);

        uint256 expectedCommunity = uint256(365 days) * share.communityFundRewardRate();
        uint256 expectedDev = uint256(365 days) * share.devFundRewardRate();

        assertEq(share.unclaimedTreasuryFund(), expectedCommunity);
        assertEq(share.unclaimedDevFund(), expectedDev);
    }

    function test_ClaimRewards_MintsAndUpdatesTimestamps() public {
        vm.warp(vestingStart + 100 days);

        uint256 expectedCommunity = uint256(100 days) * share.communityFundRewardRate();
        uint256 expectedDev = uint256(100 days) * share.devFundRewardRate();

        share.claimRewards();

        assertEq(share.balanceOf(communityFund), expectedCommunity);
        assertEq(share.balanceOf(devFund), expectedDev);
        assertEq(share.communityFundLastClaimed(), block.timestamp);
        assertEq(share.devFundLastClaimed(), block.timestamp);
    }

    function test_ClaimRewards_TwiceIsIdempotentWithoutTimeAdvance() public {
        vm.warp(vestingStart + 50 days);
        share.claimRewards();
        uint256 balanceAfterFirst = share.balanceOf(communityFund);

        // No time advance — second claim must be a no-op.
        share.claimRewards();
        assertEq(share.balanceOf(communityFund), balanceAfterFirst);
    }

    function test_ClaimRewards_AnyoneCanCall() public {
        vm.warp(vestingStart + 30 days);
        vm.prank(stranger);
        share.claimRewards();
        // Funds went to the configured recipients, not the caller.
        assertGt(share.balanceOf(communityFund), 0);
        assertGt(share.balanceOf(devFund), 0);
        assertEq(share.balanceOf(stranger), 0);
    }

    // ---------------------------------------------------------------------
    // distributeReward — one-shot farming pool mint
    // ---------------------------------------------------------------------

    function test_DistributeReward_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        share.distributeReward(farmingFund);
    }

    function test_DistributeReward_RejectsZero() public {
        vm.prank(trustees);
        vm.expectRevert(ShareToken.ZeroAddress.selector);
        share.distributeReward(address(0));
    }

    function test_DistributeReward_MintsFarmingAllocation() public {
        vm.expectEmit(true, true, true, true);
        emit RewardPoolDistributed(farmingFund);
        vm.prank(trustees);
        share.distributeReward(farmingFund);

        assertEq(share.balanceOf(farmingFund), share.FARMING_POOL_REWARD_ALLOCATION());
        assertTrue(share.rewardPoolDistributed());
    }

    function test_DistributeReward_OneShot() public {
        vm.prank(trustees);
        share.distributeReward(farmingFund);

        vm.prank(trustees);
        vm.expectRevert(ShareToken.AlreadyDistributed.selector);
        share.distributeReward(farmingFund);
    }

    // ---------------------------------------------------------------------
    // Burn
    // ---------------------------------------------------------------------

    function test_Burn_HolderCanBurnOwnBalance() public {
        vm.prank(owner);
        share.transfer(alice, 1 ether);
        vm.prank(alice);
        share.burn(1 ether);
        assertEq(share.balanceOf(alice), 0);
    }

    // ---------------------------------------------------------------------
    // Stuck-token rescue
    // ---------------------------------------------------------------------

    function test_GovernanceRecoverUnsupported_OnlyTrustees() public {
        MockERC20 stuck = new MockERC20();
        stuck.mint(address(share), 100 ether);

        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        share.governanceRecoverUnsupported(IERC20(address(stuck)), 100 ether, alice);

        vm.prank(trustees);
        share.governanceRecoverUnsupported(IERC20(address(stuck)), 100 ether, alice);
        assertEq(stuck.balanceOf(alice), 100 ether);
    }

    // ---------------------------------------------------------------------
    // Ownership transfer
    // ---------------------------------------------------------------------

    function test_OwnershipTransfer_TwoStep() public {
        vm.prank(owner);
        share.transferOwnership(alice);
        vm.prank(alice);
        share.acceptOwnership();
        assertEq(share.owner(), alice);
    }
}
