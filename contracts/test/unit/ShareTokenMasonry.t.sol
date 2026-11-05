// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ShareToken, ShareTokenProfiles} from "../../src/tokens/ShareToken.sol";

/// @dev Exercises the profile through an external call so expectRevert sees its revert.
contract ProfileHarness {
    function build(
        ShareToken.Allocation[] memory initial,
        uint256 farming,
        uint256 cap
    ) external pure returns (ShareToken.Config memory) {
        return ShareTokenProfiles.masonry(initial, farming, cap);
    }
}

/// @notice xSHARE under the Masonry launch profile (config/masonry-launch.template.json).
contract ShareTokenMasonryTest is Test {
    uint256 internal constant CAP = 33_333 ether;
    uint256 internal constant FARMING = 25_641 ether;

    address internal deployer = makeAddr("deployer");
    address internal saleEscrow = makeAddr("saleEscrow");
    address internal ownerTeamDev = makeAddr("ownerTeamDev");
    address internal treasury = makeAddr("treasury");
    address internal arbitrage = makeAddr("arbitrage");
    address internal vesting = makeAddr("vesting");
    address internal farm = makeAddr("farm");

    ShareToken internal xshare;
    ProfileHarness internal harness = new ProfileHarness();

    /// Template amounts; the template leaves the four vesting buckets unset, so the
    /// remainder (33,333 - 25,641 - 751 = 6,941) goes to one vesting contract here.
    function _initial() internal view returns (ShareToken.Allocation[] memory a) {
        a = new ShareToken.Allocation[](6);
        a[0] = ShareToken.Allocation(saleEscrow, 100 ether);
        a[1] = ShareToken.Allocation(deployer, 1 ether);
        a[2] = ShareToken.Allocation(ownerTeamDev, 100 ether);
        a[3] = ShareToken.Allocation(treasury, 500 ether);
        a[4] = ShareToken.Allocation(arbitrage, 50 ether);
        a[5] = ShareToken.Allocation(vesting, 6941 ether);
    }

    function setUp() public {
        xshare = new ShareToken(ShareTokenProfiles.masonry(_initial(), FARMING, CAP), deployer);
    }

    function test_MetadataAndInitialMint() public view {
        assertEq(xshare.name(), "xSHARE");
        assertEq(xshare.symbol(), "xSHARE");
        assertEq(xshare.decimals(), 18);
        assertEq(xshare.maxSupply(), CAP);
        assertEq(xshare.totalSupply(), CAP - FARMING);
        assertEq(xshare.totalMinted(), CAP - FARMING);
        assertEq(xshare.balanceOf(treasury), 500 ether);
        assertEq(xshare.balanceOf(vesting), 6941 ether);
        assertEq(xshare.COMMUNITY_FUND_POOL_ALLOCATION(), 0);
        assertEq(xshare.DEV_FUND_POOL_ALLOCATION(), 0);
    }

    function test_FarmingMintsOnceAndReachesTheCapExactly() public {
        vm.prank(deployer);
        xshare.distributeReward(farm);
        assertEq(xshare.balanceOf(farm), FARMING);
        assertEq(xshare.totalSupply(), CAP);
        assertEq(xshare.totalMinted(), CAP);
        vm.prank(deployer);
        vm.expectRevert(ShareToken.AlreadyDistributed.selector);
        xshare.distributeReward(farm);
    }

    function test_NoLegacyDripMintsAnything() public {
        vm.warp(block.timestamp + 400 days);
        xshare.claimRewards();
        assertEq(xshare.totalMinted(), CAP - FARMING);
    }

    function test_BurnsAreCountedAndDoNotFreeCapRoom() public {
        vm.prank(treasury);
        xshare.burn(200 ether);
        assertEq(xshare.totalBurned(), 200 ether);
        assertEq(xshare.totalSupply(), CAP - FARMING - 200 ether);
        vm.prank(deployer);
        xshare.distributeReward(farm);
        assertEq(xshare.totalMinted(), CAP);
        assertEq(xshare.totalSupply(), CAP - 200 ether);
    }

    function test_ProfileRejectsAnyMismatchWithTheCap() public {
        ShareToken.Allocation[] memory a = _initial();
        a[5].amount -= 1;
        vm.expectRevert(ShareToken.InvalidConfiguration.selector);
        harness.build(a, FARMING, CAP);
    }

    function test_ConstructorRejectsSchedulesOverTheCap() public {
        ShareToken.Config memory c = ShareTokenProfiles.masonry(_initial(), FARMING, CAP);
        c.farmingAllocation += 1;
        vm.expectRevert(ShareToken.CapExceeded.selector);
        new ShareToken(c, deployer);
    }

    function test_ConstructorRejectsZeroRecipients() public {
        ShareToken.Config memory c = ShareTokenProfiles.masonry(_initial(), FARMING, CAP);
        c.initial[0].to = address(0);
        vm.expectRevert(ShareToken.ZeroAddress.selector);
        new ShareToken(c, deployer);
    }
}
