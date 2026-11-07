// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";
import {MockOracle} from "../utils/MockOracle.sol";

import {Treasury} from "../../src/core/Treasury.sol";
import {Boardroom} from "../../src/core/Boardroom.sol";
import {PegToken} from "../../src/tokens/PegToken.sol";
import {ShareToken} from "../../src/tokens/ShareToken.sol";
import {TrustNote} from "../../src/tokens/TrustNote.sol";
import {ITreasury} from "../../src/interfaces/ITreasury.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Regression coverage for production expansion gates (E1, O1, E2, empty Masonry).
contract TreasuryProductionGatesTest is BaseTest {
    Treasury internal treasury;
    Boardroom internal boardroom;
    PegToken internal money;
    ShareToken internal estate;
    TrustNote internal trustnote;
    MockOracle internal oracle;

    address internal communityFund = makeAddr("communityFund");
    address internal devFund = makeAddr("devFund");
    uint256 internal startTime;
    uint256 internal constant PERIOD = 6 hours;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        startTime = block.timestamp + 1 hours;

        vm.startPrank(owner);
        money = new PegToken(owner);
        estate = new ShareToken(startTime, communityFund, devFund, owner);
        trustnote = new TrustNote(owner);
        oracle = new MockOracle(1e18);
        treasury = new Treasury(owner);
        boardroom = new Boardroom(owner);
        boardroom.initialize(IERC20(address(money)), IERC20(address(estate)), ITreasury(address(treasury)));
        address[] memory excluded = new address[](0);
        treasury.initialize(
            address(money), address(trustnote), address(estate), address(oracle), address(boardroom), startTime, excluded
        );
        money.distributeReward(address(this), address(this), address(this));
        estate.distributeReward(address(this));
        money.transferTrustees(address(treasury));
        estate.transferTrustees(address(treasury));
        trustnote.transferTrustees(address(treasury));
        boardroom.setOperator(address(treasury));
        vm.stopPrank();

        estate.transfer(alice, 1_000 ether);
        vm.warp(startTime + 1);
    }

    function _stakeAlice() internal {
        vm.startPrank(alice);
        estate.approve(address(boardroom), 1_000 ether);
        boardroom.stake(1_000 ether);
        vm.stopPrank();
        vm.roll(block.number + 1);
    }

    function test_E1_BootstrapDoesNotMintBelowOrAtPeg() public {
        _stakeAlice();
        assertEq(treasury.bootstrapEpochs(), 28);
        assertLt(treasury.epoch(), treasury.bootstrapEpochs());

        oracle.setPrice(1e18); // at peg
        uint256 supplyBefore = money.totalSupply();
        treasury.allocateSeigniorage();
        assertEq(money.totalSupply(), supplyBefore);
        assertEq(treasury.epoch(), 1);

        vm.warp(treasury.nextEpochPoint() + 1);
        vm.roll(block.number + 1);
        oracle.setPrice(1.01e18); // equal to ceiling, not strictly above
        treasury.allocateSeigniorage();
        assertEq(money.totalSupply(), supplyBefore);
    }

    function test_E1_FreshTwapAboveCeilingMints() public {
        _stakeAlice();
        oracle.setPrice(1.05e18);
        uint256 supplyBefore = money.totalSupply();
        treasury.allocateSeigniorage();
        assertGt(money.totalSupply(), supplyBefore);
        assertGt(money.balanceOf(address(boardroom)), 0);
    }

    function test_O1_StaleOracleSkipsMintAndAdvancesEpoch() public {
        _stakeAlice();
        oracle.setPrice(1.05e18);
        oracle.setFresh(false);
        uint256 supplyBefore = money.totalSupply();
        treasury.allocateSeigniorage();
        assertEq(money.totalSupply(), supplyBefore);
        assertEq(treasury.epoch(), 1);
        vm.roll(block.number + 1);
        vm.expectRevert(Treasury.NotEpochYet.selector);
        treasury.allocateSeigniorage();
    }

    function test_E2_MissedEpochsDoNotCatchUpMint() public {
        _stakeAlice();
        oracle.setPrice(1.05e18);
        vm.warp(startTime + 3 * PERIOD + 1);
        uint256 supplyBefore = money.totalSupply();
        treasury.allocateSeigniorage();
        uint256 mintedOnce = money.totalSupply() - supplyBefore;
        assertGt(mintedOnce, 0);
        // Three missed periods collapse to a single tick: next call is not yet due.
        assertEq(treasury.epoch(), (block.timestamp - startTime) / PERIOD + 1);
        vm.roll(block.number + 1);
        vm.expectRevert(Treasury.NotEpochYet.selector);
        treasury.allocateSeigniorage();
        assertEq(money.totalSupply() - supplyBefore, mintedOnce);
    }

    function test_EmptyMasonryDoesNotBrickEpoch() public {
        // No stake — Boardroom totalSupply is 0.
        oracle.setPrice(1.05e18);
        uint256 supplyBefore = money.totalSupply();
        treasury.allocateSeigniorage();
        assertEq(money.totalSupply(), supplyBefore);
        assertEq(treasury.epoch(), 1);
        vm.roll(block.number + 1);
        vm.expectRevert(Treasury.NotEpochYet.selector);
        treasury.allocateSeigniorage();
    }
}
