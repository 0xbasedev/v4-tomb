// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, StdInvariant} from "forge-std/Test.sol";

import {Masonry} from "../../src/core/Masonry.sol";
import {ShareToken} from "../../src/tokens/ShareToken.sol";
import {PegToken} from "../../src/tokens/PegToken.sol";
import {ITreasury} from "../../src/interfaces/ITreasury.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Bare-minimum ITreasury implementation so the Masonry's view-throughs work.
///         Epoch is settable so we can bypass the withdraw lockup at will.
contract MockTreasury is ITreasury {
    uint256 public epoch_;

    function setEpoch(
        uint256 e
    ) external {
        epoch_ = e;
    }

    function epoch() external view returns (uint256) {
        return epoch_;
    }

    function nextEpochPoint() external view returns (uint256) {
        return type(uint256).max;
    }

    function getPegPrice() external pure returns (uint256) {
        return 1e18;
    }
}

/**
 * @title MasonryHandler
 * @notice Drives stake / withdraw / exit actions across three actors. Each action pranks the
 *         actor so msg.sender inside the Masonry is that actor (which is what the
 *         memberExists, updateReward, and stake-tracking logic depends on).
 *
 *         The handler bypasses the onlyOneBlock guard between actions by rolling forward
 *         one block before each call.
 */
contract MasonryHandler is Test {
    Masonry public masonry;
    ShareToken public share;
    MockTreasury public treasury;

    address[] public actors;

    constructor(
        Masonry _masonry,
        ShareToken _share,
        MockTreasury _treasury
    ) {
        masonry = _masonry;
        share = _share;
        treasury = _treasury;
        actors.push(makeAddr("alice"));
        actors.push(makeAddr("bob"));
        actors.push(makeAddr("carol"));
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function stake(
        uint256 actorSeed,
        uint256 amount
    ) external {
        address actor = actors[actorSeed % actors.length];
        uint256 balance = share.balanceOf(actor);
        if (balance == 0) return;
        amount = bound(amount, 1, balance);

        vm.roll(block.number + 1);
        vm.prank(actor);
        share.approve(address(masonry), amount);
        vm.roll(block.number + 1);
        vm.prank(actor);
        masonry.stake(amount);
    }

    function withdraw(
        uint256 actorSeed,
        uint256 amount
    ) external {
        address actor = actors[actorSeed % actors.length];
        uint256 staked = masonry.balanceOf(actor);
        if (staked == 0) return;
        amount = bound(amount, 1, staked);

        // Advance mock treasury epoch enough that the lockup never blocks.
        treasury.setEpoch(treasury.epoch() + 100);

        vm.roll(block.number + 1);
        vm.prank(actor);
        masonry.withdraw(amount);
    }

    function exit(
        uint256 actorSeed
    ) external {
        address actor = actors[actorSeed % actors.length];
        uint256 staked = masonry.balanceOf(actor);
        if (staked == 0) return;
        treasury.setEpoch(treasury.epoch() + 100);
        vm.roll(block.number + 1);
        vm.prank(actor);
        masonry.exit();
    }

    /// @notice Move SHARE between actors so the fuzzer has reason to stake from many directions.
    function shuffleShareToken(
        uint256 fromSeed,
        uint256 toSeed,
        uint256 amount
    ) external {
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 balance = share.balanceOf(from);
        if (balance == 0) return;
        amount = bound(amount, 1, balance);
        vm.prank(from);
        share.transfer(to, amount);
    }
}

contract MasonryInvariants is StdInvariant, Test {
    PegToken public peg;
    ShareToken public share;
    Masonry public masonry;
    MockTreasury public treasury;
    MasonryHandler public handler;

    address public farmingPool = makeAddr("farmingPool");
    address public communityFund = makeAddr("communityFund");
    address public devFund = makeAddr("devFund");

    function setUp() public {
        vm.warp(1_700_000_000);

        // 1. Deploy tokens (deployer = trustees of each).
        peg = new PegToken("Peg Token", "PEG");
        share = new ShareToken("Share Token", "SHARE", block.timestamp + 1 hours, communityFund, devFund);

        // 2. Mock treasury.
        treasury = new MockTreasury();

        // 3. Masonry (deployer is the initial operator).
        masonry = new Masonry();
        masonry.initialize(IERC20(address(peg)), IERC20(address(share)), ITreasury(address(treasury)));

        // 4. Mint SHARE supply via distributeReward, then push to test actors.
        share.distributeReward(farmingPool);

        handler = new MasonryHandler(masonry, share, treasury);

        // Seed each actor with some SHARE. Use the farming pool's balance.
        vm.startPrank(farmingPool);
        share.transfer(handler.actors(0), 5000 ether);
        share.transfer(handler.actors(1), 5000 ether);
        share.transfer(handler.actors(2), 5000 ether);
        vm.stopPrank();

        targetContract(address(handler));
    }

    // ---------------------------------------------------------------------
    // Core invariant: no SHARE is ever lost or duplicated
    // ---------------------------------------------------------------------

    /// @notice The Masonry's internal totalSupply tracker must equal the SHARE held by
    ///         the Masonry contract. This is the no-leak no-counterfeit invariant.
    function invariant_TotalSupplyMatchesShareTokenHeld() public view {
        assertEq(masonry.totalSupply(), share.balanceOf(address(masonry)));
    }

    /// @notice Sum of every actor's recorded stake equals the masonry's totalSupply.
    function invariant_SumOfMemberBalancesEqualsTotalSupply() public view {
        uint256 sum;
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            sum += masonry.balanceOf(handler.actors(i));
        }
        assertEq(sum, masonry.totalSupply());
    }

    /// @notice No individual actor can have more staked than the total.
    function invariant_NoStakeExceedsTotal() public view {
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            assertLe(masonry.balanceOf(handler.actors(i)), masonry.totalSupply());
        }
    }

    /// @notice SHARE supply is conserved: the deployer's mint, farming pool, three actors,
    ///         and the masonry together hold all of share.totalSupply().
    function invariant_NoShareTokenLost() public view {
        uint256 sum = share.balanceOf(address(this)); // deployer 1 ether
        sum += share.balanceOf(farmingPool);
        sum += share.balanceOf(communityFund);
        sum += share.balanceOf(devFund);
        sum += share.balanceOf(address(masonry));
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            sum += share.balanceOf(handler.actors(i));
        }
        assertEq(sum, share.totalSupply());
    }
}
