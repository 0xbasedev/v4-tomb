// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {DeployMasonryLocal} from "../../script/DeployMasonryLocal.s.sol";
import {MasonryLinearVesting} from "../../src/masonry/MasonryLinearVesting.sol";

/// @notice The local launch must mint xSHARE exactly as the owner-decided split:
/// four 180-day streams (1,000 / 1,000 / 2,940 / 1,901) and 101 liquid with the deployer/DAO.
contract DeployMasonryLocalVestingTest is Test {
    DeployMasonryLocal.Deployed internal d;
    uint256 internal deployedAt;

    function setUp() public {
        vm.createDir("./deployment-output", true);
        deployedAt = block.timestamp;
        d = new DeployMasonryLocal().run();
    }

    function test_VestingSplitMatchesOwnerDecision() public view {
        uint256[4] memory expected = [uint256(1000 ether), 1000 ether, 2940 ether, 1901 ether];
        uint256 total;
        for (uint256 i; i < 4; ++i) {
            MasonryLinearVesting v = d.vesting[i];
            assertTrue(v.funded());
            assertEq(v.vestingTotal(), expected[i]);
            assertEq(v.upfrontReleased(), 0);
            assertEq(d.square.balanceOf(address(v)), expected[i]);
            assertEq(v.end() - v.start(), 180 days);
            assertEq(v.start(), deployedAt + 1 hours);
            assertEq(address(v.asset()), address(d.square));
            total += expected[i];
        }
        assertEq(total, 6841 ether);
        assertEq(d.vesting[2].beneficiary(), d.treasury);
    }

    function test_SupplyReconcilesToCapWithFarmingStillUnminted() public view {
        // 33,333 cap = 25,641 farming (minted to the Farm later) + 7,692 minted at deploy.
        assertEq(d.square.totalSupply(), 7692 ether);
        assertEq(d.square.maxSupply(), 33_333 ether);
    }

    function test_StreamsReleaseLinearlyToTheirBeneficiaryOnly() public {
        MasonryLinearVesting team = d.vesting[0];
        address who = team.beneficiary();
        vm.expectRevert(MasonryLinearVesting.NothingToRelease.selector);
        team.release();

        uint256 before = d.square.balanceOf(who);
        vm.warp(team.start() + 45 days);
        vm.prank(address(0xBEEF));
        assertEq(team.release(), 250 ether);
        assertEq(d.square.balanceOf(who) - before, 250 ether);

        vm.warp(team.end() + 1);
        team.release();
        assertEq(d.square.balanceOf(who) - before, 1000 ether);
        assertEq(d.square.balanceOf(address(team)), 0);
    }
}
