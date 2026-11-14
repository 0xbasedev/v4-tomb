// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, StdInvariant} from "forge-std/Test.sol";

import {Boardroom} from "../../src/core/Boardroom.sol";
import {ShareToken, ShareTokenProfiles} from "../../src/tokens/ShareToken.sol";
import {PegToken} from "../../src/tokens/PegToken.sol";
import {ITreasury} from "../../src/interfaces/ITreasury.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Bare-minimum ITreasury implementation so the Boardroom's view-throughs work.
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

    function getMoneyPrice() external pure returns (uint256) {
        return 1e18;
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

/**
 * @title BoardroomHandler
 * @notice Drives stake / withdraw / exit actions across three actors. Each action pranks the
 *         actor so msg.sender inside the Boardroom is that actor (which is what the
 *         memberExists, updateReward, and stake-tracking logic depends on).
 *
 *         The handler bypasses the onlyOneBlock guard between actions by rolling forward
 *         one block before each call.
 */
contract BoardroomHandler is Test {
    Boardroom public boardroom;
    ShareToken public estate;
    MockTreasury public treasury;

    address[] public actors;

    constructor(
        Boardroom _boardroom,
        ShareToken _estate,
        MockTreasury _treasury
    ) {
        boardroom = _boardroom;
        estate = _estate;
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
        uint256 balance = estate.balanceOf(actor);
        if (balance == 0) return;
        amount = bound(amount, 1, balance);

        vm.roll(block.number + 1);
        vm.prank(actor);
        estate.approve(address(boardroom), amount);
        vm.roll(block.number + 1);
        vm.prank(actor);
        boardroom.stake(amount);
    }

    function withdraw(
        uint256 actorSeed,
        uint256 amount
    ) external {
        address actor = actors[actorSeed % actors.length];
        uint256 staked = boardroom.balanceOf(actor);
        if (staked == 0) return;
        amount = bound(amount, 1, staked);

        // Advance mock treasury epoch enough that the lockup never blocks.
        treasury.setEpoch(treasury.epoch() + 100);

        vm.roll(block.number + 1);
        vm.prank(actor);
        boardroom.withdraw(amount);
    }

    function exit(
        uint256 actorSeed
    ) external {
        address actor = actors[actorSeed % actors.length];
        uint256 staked = boardroom.balanceOf(actor);
        if (staked == 0) return;
        treasury.setEpoch(treasury.epoch() + 100);
        vm.roll(block.number + 1);
        vm.prank(actor);
        boardroom.exit();
    }

    /// @notice Move ESTATE between actors so the fuzzer has reason to stake from many directions.
    function shuffleEstate(
        uint256 fromSeed,
        uint256 toSeed,
        uint256 amount
    ) external {
        address from = actors[fromSeed % actors.length];
        address to = actors[toSeed % actors.length];
        uint256 balance = estate.balanceOf(from);
        if (balance == 0) return;
        amount = bound(amount, 1, balance);
        vm.prank(from);
        estate.transfer(to, amount);
    }
}

contract BoardroomInvariants is StdInvariant, Test {
    PegToken public money;
    ShareToken public estate;
    Boardroom public boardroom;
    MockTreasury public treasury;
    BoardroomHandler public handler;

    address public farmingPool = makeAddr("farmingPool");
    address public communityFund = makeAddr("communityFund");
    address public devFund = makeAddr("devFund");

    function setUp() public {
        vm.warp(1_700_000_000);

        // 1. Deploy tokens (deployer = trustees of each).
        money = new PegToken(address(this));
        estate = new ShareToken(
            ShareTokenProfiles.legacy(block.timestamp + 1 hours, communityFund, devFund, address(this)), address(this)
        );

        // 2. Mock treasury.
        treasury = new MockTreasury();

        // 3. Boardroom (deployer is the initial operator).
        boardroom = new Boardroom(address(this));
        boardroom.initialize(IERC20(address(money)), IERC20(address(estate)), ITreasury(address(treasury)));

        // 4. Mint ESTATE supply via distributeReward, then push to test actors.
        estate.distributeReward(farmingPool);

        handler = new BoardroomHandler(boardroom, estate, treasury);

        // Seed each actor with some ESTATE. Use the farming pool's balance.
        vm.startPrank(farmingPool);
        estate.transfer(handler.actors(0), 5000 ether);
        estate.transfer(handler.actors(1), 5000 ether);
        estate.transfer(handler.actors(2), 5000 ether);
        vm.stopPrank();

        targetContract(address(handler));
    }

    // ---------------------------------------------------------------------
    // Core invariant: no ESTATE is ever lost or duplicated
    // ---------------------------------------------------------------------

    /// @notice The Boardroom's internal totalSupply tracker must equal the ESTATE held by
    ///         the Boardroom contract. This is the no-leak no-counterfeit invariant.
    function invariant_TotalSupplyMatchesEstateHeld() public view {
        assertEq(boardroom.totalSupply(), estate.balanceOf(address(boardroom)));
    }

    /// @notice Sum of every actor's recorded stake equals the boardroom's totalSupply.
    function invariant_SumOfMemberBalancesEqualsTotalSupply() public view {
        uint256 sum;
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            sum += boardroom.balanceOf(handler.actors(i));
        }
        assertEq(sum, boardroom.totalSupply());
    }

    /// @notice No individual actor can have more staked than the total.
    function invariant_NoStakeExceedsTotal() public view {
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            assertLe(boardroom.balanceOf(handler.actors(i)), boardroom.totalSupply());
        }
    }

    /// @notice ESTATE supply is conserved: the deployer's mint, farming pool, three actors,
    ///         and the boardroom together hold all of estate.totalSupply().
    function invariant_NoEstateLost() public view {
        uint256 sum = estate.balanceOf(address(this)); // deployer 1 ether
        sum += estate.balanceOf(farmingPool);
        sum += estate.balanceOf(communityFund);
        sum += estate.balanceOf(devFund);
        sum += estate.balanceOf(address(boardroom));
        for (uint256 i = 0; i < handler.actorCount(); ++i) {
            sum += estate.balanceOf(handler.actors(i));
        }
        assertEq(sum, estate.totalSupply());
    }
}
