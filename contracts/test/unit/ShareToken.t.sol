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
    ShareToken internal estate;

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
        estate = new ShareToken(vestingStart, communityFund, devFund, owner);

        // Rotate trustees from `owner` (the deployer default) to the dedicated `trustees` actor.
        vm.prank(owner);
        estate.transferTrustees(trustees);
    }

    // ---------------------------------------------------------------------
    // Constructor / metadata
    // ---------------------------------------------------------------------

    function test_Metadata() public view {
        assertEq(estate.name(), "Estate");
        assertEq(estate.symbol(), "ESTATE");
        assertEq(estate.decimals(), 18);
    }

    function test_Constants() public view {
        assertEq(estate.FARMING_POOL_REWARD_ALLOCATION(), 59_500 ether);
        assertEq(estate.COMMUNITY_FUND_POOL_ALLOCATION(), 5500 ether);
        assertEq(estate.DEV_FUND_POOL_ALLOCATION(), 5000 ether);
        assertEq(estate.VESTING_DURATION(), 365 days);
    }

    function test_ConstantsSumToTombMaxSupply() public view {
        // Tomb canonical: 70,000 TSHARE max supply (59,500 + 5,500 + 5,000).
        assertEq(
            estate.FARMING_POOL_REWARD_ALLOCATION() + estate.COMMUNITY_FUND_POOL_ALLOCATION()
                + estate.DEV_FUND_POOL_ALLOCATION(),
            70_000 ether
        );
    }

    function test_Constructor_InitialState() public view {
        // 1 ether minted to the deployer.
        assertEq(estate.balanceOf(owner), 1 ether);
        assertEq(estate.totalSupply(), 1 ether);

        assertEq(estate.startTime(), vestingStart);
        assertEq(estate.endTime(), vestingStart + 365 days);
        assertEq(estate.communityFund(), communityFund);
        assertEq(estate.devFund(), devFund);
        assertEq(estate.communityFundLastClaimed(), vestingStart);
        assertEq(estate.devFundLastClaimed(), vestingStart);

        // Vesting rates are alloc / duration.
        assertEq(estate.communityFundRewardRate(), uint256(5500 ether) / 365 days);
        assertEq(estate.devFundRewardRate(), uint256(5000 ether) / 365 days);
    }

    function test_Constructor_RejectsZeroCommunityFund() public {
        vm.prank(owner);
        vm.expectRevert(ShareToken.ZeroAddress.selector);
        new ShareToken(vestingStart, address(0), devFund, address(this));
    }

    function test_Constructor_RejectsZeroDevFund() public {
        vm.prank(owner);
        vm.expectRevert(ShareToken.ZeroAddress.selector);
        new ShareToken(vestingStart, communityFund, address(0), address(this));
    }

    // ---------------------------------------------------------------------
    // setTreasuryFund / setDevFund — Tomb's devFund-controlled rotation quirk
    // ---------------------------------------------------------------------

    function test_SetTreasuryFund_OnlyDevFund() public {
        vm.prank(owner);
        vm.expectRevert(ShareToken.NotDevFund.selector);
        estate.setTreasuryFund(alice);

        vm.prank(stranger);
        vm.expectRevert(ShareToken.NotDevFund.selector);
        estate.setTreasuryFund(alice);
    }

    function test_SetTreasuryFund_RejectsZero() public {
        vm.prank(devFund);
        vm.expectRevert(ShareToken.ZeroAddress.selector);
        estate.setTreasuryFund(address(0));
    }

    function test_SetTreasuryFund_Rotates() public {
        vm.expectEmit(true, true, true, true);
        emit CommunityFundUpdated(communityFund, alice);
        vm.prank(devFund);
        estate.setTreasuryFund(alice);
        assertEq(estate.communityFund(), alice);
    }

    function test_SetDevFund_OnlyDevFund() public {
        vm.prank(owner);
        vm.expectRevert(ShareToken.NotDevFund.selector);
        estate.setDevFund(alice);
    }

    function test_SetDevFund_RejectsZero() public {
        vm.prank(devFund);
        vm.expectRevert(ShareToken.ZeroAddress.selector);
        estate.setDevFund(address(0));
    }

    function test_SetDevFund_Rotates() public {
        vm.expectEmit(true, true, true, true);
        emit DevFundUpdated(devFund, alice);
        vm.prank(devFund);
        estate.setDevFund(alice);
        assertEq(estate.devFund(), alice);
    }

    // ---------------------------------------------------------------------
    // Linear vesting math (claimRewards)
    // ---------------------------------------------------------------------

    function test_Vesting_NothingClaimableBeforeStart() public view {
        // We're currently before vestingStart.
        assertLt(block.timestamp, vestingStart);
        assertEq(estate.unclaimedTreasuryFund(), 0);
        assertEq(estate.unclaimedDevFund(), 0);
    }

    function test_Vesting_HalfwayThrough() public {
        // Jump to vestingStart + 6 months.
        vm.warp(vestingStart + 182.5 days);

        uint256 communityRate = estate.communityFundRewardRate();
        uint256 devRate = estate.devFundRewardRate();
        uint256 expectedCommunity = uint256(182.5 days) * communityRate;
        uint256 expectedDev = uint256(182.5 days) * devRate;

        assertEq(estate.unclaimedTreasuryFund(), expectedCommunity);
        assertEq(estate.unclaimedDevFund(), expectedDev);
    }

    function test_Vesting_FullyClaimableAtEnd() public {
        vm.warp(vestingStart + 365 days);

        uint256 expectedCommunity = uint256(365 days) * estate.communityFundRewardRate();
        uint256 expectedDev = uint256(365 days) * estate.devFundRewardRate();

        assertEq(estate.unclaimedTreasuryFund(), expectedCommunity);
        assertEq(estate.unclaimedDevFund(), expectedDev);

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

        uint256 expectedCommunity = uint256(365 days) * estate.communityFundRewardRate();
        uint256 expectedDev = uint256(365 days) * estate.devFundRewardRate();

        assertEq(estate.unclaimedTreasuryFund(), expectedCommunity);
        assertEq(estate.unclaimedDevFund(), expectedDev);
    }

    function test_ClaimRewards_MintsAndUpdatesTimestamps() public {
        vm.warp(vestingStart + 100 days);

        uint256 expectedCommunity = uint256(100 days) * estate.communityFundRewardRate();
        uint256 expectedDev = uint256(100 days) * estate.devFundRewardRate();

        estate.claimRewards();

        assertEq(estate.balanceOf(communityFund), expectedCommunity);
        assertEq(estate.balanceOf(devFund), expectedDev);
        assertEq(estate.communityFundLastClaimed(), block.timestamp);
        assertEq(estate.devFundLastClaimed(), block.timestamp);
    }

    function test_ClaimRewards_TwiceIsIdempotentWithoutTimeAdvance() public {
        vm.warp(vestingStart + 50 days);
        estate.claimRewards();
        uint256 balanceAfterFirst = estate.balanceOf(communityFund);

        // No time advance — second claim must be a no-op.
        estate.claimRewards();
        assertEq(estate.balanceOf(communityFund), balanceAfterFirst);
    }

    function test_ClaimRewards_AnyoneCanCall() public {
        vm.warp(vestingStart + 30 days);
        vm.prank(stranger);
        estate.claimRewards();
        // Funds went to the configured recipients, not the caller.
        assertGt(estate.balanceOf(communityFund), 0);
        assertGt(estate.balanceOf(devFund), 0);
        assertEq(estate.balanceOf(stranger), 0);
    }

    // ---------------------------------------------------------------------
    // distributeReward — one-shot farming pool mint
    // ---------------------------------------------------------------------

    function test_DistributeReward_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        estate.distributeReward(farmingFund);
    }

    function test_DistributeReward_RejectsZero() public {
        vm.prank(trustees);
        vm.expectRevert(ShareToken.ZeroAddress.selector);
        estate.distributeReward(address(0));
    }

    function test_DistributeReward_MintsFarmingAllocation() public {
        vm.expectEmit(true, true, true, true);
        emit RewardPoolDistributed(farmingFund);
        vm.prank(trustees);
        estate.distributeReward(farmingFund);

        assertEq(estate.balanceOf(farmingFund), estate.FARMING_POOL_REWARD_ALLOCATION());
        assertTrue(estate.rewardPoolDistributed());
    }

    function test_DistributeReward_OneShot() public {
        vm.prank(trustees);
        estate.distributeReward(farmingFund);

        vm.prank(trustees);
        vm.expectRevert(ShareToken.AlreadyDistributed.selector);
        estate.distributeReward(farmingFund);
    }

    // ---------------------------------------------------------------------
    // Burn
    // ---------------------------------------------------------------------

    function test_Burn_HolderCanBurnOwnBalance() public {
        vm.prank(owner);
        estate.transfer(alice, 1 ether);
        vm.prank(alice);
        estate.burn(1 ether);
        assertEq(estate.balanceOf(alice), 0);
    }

    // ---------------------------------------------------------------------
    // Stuck-token rescue
    // ---------------------------------------------------------------------

    function test_GovernanceRecoverUnsupported_OnlyTrustees() public {
        MockERC20 stuck = new MockERC20();
        stuck.mint(address(estate), 100 ether);

        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        estate.governanceRecoverUnsupported(IERC20(address(stuck)), 100 ether, alice);

        vm.prank(trustees);
        estate.governanceRecoverUnsupported(IERC20(address(stuck)), 100 ether, alice);
        assertEq(stuck.balanceOf(alice), 100 ether);
    }

    // ---------------------------------------------------------------------
    // Ownership transfer
    // ---------------------------------------------------------------------

    function test_OwnershipTransfer_TwoStep() public {
        vm.prank(owner);
        estate.transferOwnership(alice);
        vm.prank(alice);
        estate.acceptOwnership();
        assertEq(estate.owner(), alice);
    }
}
