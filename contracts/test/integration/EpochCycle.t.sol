// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";
import {MockOracle} from "../utils/MockOracle.sol";

import {OldMoney} from "../../src/tokens/OldMoney.sol";
import {Estate} from "../../src/tokens/Estate.sol";
import {TrustNote} from "../../src/tokens/TrustNote.sol";
import {Treasury} from "../../src/core/Treasury.sol";
import {Boardroom} from "../../src/core/Boardroom.sol";
import {Trustees} from "../../src/governance/Trustees.sol";
import {ITreasury} from "../../src/interfaces/ITreasury.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title EpochCycle integration test
 * @notice Exercises the full Old Money system as it would behave on Base: deploy every
 *         contract, wire the operator handoffs the same way the production deploy script
 *         will, run through expansion → staker claim → contraction → bond purchase →
 *         recovery expansion → bond redemption at premium. The Oracle is mocked so the
 *         price can be driven deterministically.
 *
 *         This is the "does the whole thing work together" sanity test. Detailed invariant
 *         and fuzz coverage lives in test/invariant/ (Sprint 8). Detailed unit coverage of
 *         each contract lives in test/unit/.
 */
contract EpochCycleTest is BaseTest {
    OldMoney internal money;
    Estate internal estate;
    TrustNote internal trustnote;
    Treasury internal treasury;
    Boardroom internal boardroom;
    MockOracle internal oracle;

    address internal genesisPool = makeAddr("genesisPool");
    address internal mainPool = makeAddr("mainPool");
    address internal airdropWallet = makeAddr("airdropWallet");
    address internal farmingPool = makeAddr("farmingPool");
    address internal communityFund = makeAddr("communityFund");
    address internal devFund = makeAddr("devFund");

    uint256 internal startTime;

    uint256 internal constant PERIOD = 6 hours;

    function setUp() public override {
        super.setUp();
        vm.label(genesisPool, "genesisPool");
        vm.label(mainPool, "mainPool");
        vm.label(airdropWallet, "airdropWallet");
        vm.label(farmingPool, "farmingPool");

        vm.warp(1_700_000_000);
        startTime = block.timestamp + 1 hours;

        // 1. Deploy tokens — owner becomes initial trustees on each.
        vm.startPrank(owner);
        money = new OldMoney();
        estate = new Estate(startTime, communityFund, devFund);
        trustnote = new TrustNote();
        vm.stopPrank();

        // 2. Mock oracle at parity (1 MONEY = 1 cbETH).
        oracle = new MockOracle(1e18);

        // 3. Deploy core contracts.
        vm.startPrank(owner);
        treasury = new Treasury();
        boardroom = new Boardroom();

        // 4. Initialize boardroom + treasury. owner becomes operator on both.
        boardroom.initialize(IERC20(address(money)), IERC20(address(estate)), ITreasury(address(treasury)));

        address[] memory excluded = new address[](3);
        excluded[0] = genesisPool;
        excluded[1] = mainPool;
        excluded[2] = airdropWallet;
        treasury.initialize(
            address(money),
            address(trustnote),
            address(estate),
            address(oracle),
            address(boardroom),
            startTime,
            excluded
        );

        // 5. One-shot genesis distributions BEFORE the operator handoff (owner is still trustees).
        money.distributeReward(genesisPool, mainPool, airdropWallet); // 11k + 140k + 9k
        estate.distributeReward(farmingPool); // 59.5k

        // Override bootstrap to 0 epochs so tests exercise post-bootstrap expansion /
        // contraction mechanics directly. Bootstrap-specific behavior is tested separately.
        // owner is still treasury.operator at this point (transferTrustees on tokens
        // doesn't rotate Treasury's own operator).
        treasury.setBootstrap(0, 100);

        // 6. Hand off mint/burn authority on every token + boardroom to Treasury.
        money.transferTrustees(address(treasury));
        estate.transferTrustees(address(treasury));
        trustnote.transferTrustees(address(treasury));
        boardroom.setOperator(address(treasury));
        vm.stopPrank();

        // 7. Distribute some ESTATE from the farming pool to test stakers.
        vm.startPrank(farmingPool);
        estate.transfer(alice, 1000 ether);
        estate.transfer(bob, 3000 ether);
        estate.transfer(carol, 6000 ether);
        vm.stopPrank();

        // 8. Drip MONEY out of mainPool into circulation. In production this happens via
        //    the LP reward pool emitting MONEY over time; we shortcut it so the
        //    circulating supply is non-trivial. Excluded addresses (genesisPool,
        //    mainPool, airdropWallet) are subtracted from circulating in the contraction
        //    headroom calculation; without this step circulating == 0 and bonds can't
        //    be sold.
        vm.startPrank(mainPool);
        money.transfer(alice, 10_000 ether);
        money.transfer(bob, 10_000 ether);
        money.transfer(carol, 10_000 ether);
        vm.stopPrank();

        // 9. Warp past startTime so checkCondition modifiers pass.
        vm.warp(startTime + 1);
    }

    // =================================================================
    // EXPANSION PHASE
    // =================================================================

    function test_Expansion_AllocatesSeigniorageToBoardroom() public {
        _stakeAll();

        // Drive oracle above ceiling (1.01e18) — say 1.05e18.
        oracle.setPrice(1.05e18);

        // Advance to next epoch and allocate.
        vm.warp(treasury.nextEpochPoint() + 1);
        vm.roll(block.number + 1);
        treasury.allocateSeigniorage();

        // Treasury minted MONEY and routed it to boardroom (no daoFund/devFund set yet).
        // At 1.05e18 with supply ~160k (genesis), the mse cap (4%) bites:
        //   percentage = min(0.05, 0.04) * 1e18 = 0.04e18
        //   savedForBoardroom = supply * 0.04 ≈ 160k * 0.04 = 6.4k MONEY
        // Pre-distribution MONEY in boardroom was 0; after, it's the seigniorage.
        assertGt(money.balanceOf(address(boardroom)), 0);
        assertEq(treasury.epoch(), 1);

        // Each staker has accrued reward proportional to their stake.
        uint256 totalStake = boardroom.totalSupply();
        assertEq(totalStake, 10_000 ether); // 1k + 3k + 6k

        uint256 aliceEarn = boardroom.earned(alice);
        uint256 bobEarn = boardroom.earned(bob);
        uint256 carolEarn = boardroom.earned(carol);
        // bob earned 3x alice; carol earned 6x alice.
        assertApproxEqRel(bobEarn, aliceEarn * 3, 0.001e18);
        assertApproxEqRel(carolEarn, aliceEarn * 6, 0.001e18);
    }

    function test_Expansion_StakerClaimsAfterRewardLockup() public {
        _stakeAll();
        oracle.setPrice(1.05e18);

        vm.warp(treasury.nextEpochPoint() + 1);
        vm.roll(block.number + 1);
        treasury.allocateSeigniorage();

        uint256 aliceEarn = boardroom.earned(alice);
        assertGt(aliceEarn, 0);

        // Reward lockup is 3 epochs — must advance treasury.epoch() past then.
        for (uint256 i = 0; i < 3; ++i) {
            vm.warp(treasury.nextEpochPoint() + 1);
            vm.roll(block.number + 1);
            treasury.allocateSeigniorage();
        }

        uint256 moneyBefore = money.balanceOf(alice);
        vm.prank(alice);
        boardroom.claimReward();
        uint256 moneyAfter = money.balanceOf(alice);
        assertGt(moneyAfter, moneyBefore);
    }

    // =================================================================
    // CONTRACTION PHASE — bond purchase
    // =================================================================

    function test_Contraction_UserCanBuyBondsAtSubPeg() public {
        _stakeAll();
        // First epoch needs to be allocated (above peg, no contraction yet) so that
        // the *second* epoch's checkEpoch sets epochSupplyContractionLeft when sub-peg.
        _allocateAtPrice(1.05e18);

        // Now drive price below peg.
        oracle.setPrice(0.9e18);
        _allocateAtPrice(0.9e18);

        // epochSupplyContractionLeft is now non-zero.
        uint256 contractionLeft = treasury.epochSupplyContractionLeft();
        assertGt(contractionLeft, 0);

        // Alice already has 10k MONEY from setUp; approve treasury for the bond burn.
        vm.prank(alice);
        money.approve(address(treasury), 100 ether);

        uint256 priceNow = treasury.getMoneyPrice();
        uint256 moneyBefore = money.balanceOf(alice);
        vm.roll(block.number + 1);
        vm.prank(alice);
        treasury.buyBonds(100 ether, priceNow);

        // Default discountPercent is 0 → rate == moneyPriceOne → 1:1 swap.
        assertEq(money.balanceOf(alice), moneyBefore - 100 ether);
        assertEq(trustnote.balanceOf(alice), 100 ether);
        // Contraction headroom decreased.
        assertEq(treasury.epochSupplyContractionLeft(), contractionLeft - 100 ether);
    }

    function test_Contraction_BuyBondsRejectsAbovePeg() public {
        _stakeAll();
        _allocateAtPrice(1.05e18);

        // Still above peg.
        oracle.setPrice(1.05e18);
        vm.prank(mainPool);
        money.transfer(alice, 100 ether);
        vm.prank(alice);
        money.approve(address(treasury), 100 ether);

        vm.roll(block.number + 1);
        vm.prank(alice);
        vm.expectRevert(Treasury.PriceNotEligible.selector);
        treasury.buyBonds(100 ether, 1.05e18);
    }

    function test_Contraction_BuyBondsAppliesDiscountWhenConfigured() public {
        // Configure a 50% discount factor.
        vm.prank(owner);
        treasury.setDiscountPercent(5000);

        _stakeAll();
        _allocateAtPrice(1.05e18);

        oracle.setPrice(0.9e18);
        _allocateAtPrice(0.9e18);

        uint256 price = treasury.getMoneyPrice();
        uint256 rate = treasury.getBondDiscountRate();
        // Tomb math: rate = moneyPriceOne + (moneyPriceOne * 1e18 / price - moneyPriceOne)
        //                   * discountPercent / 10000
        // At price 0.9e18, discountPercent 5000:
        //   bondAmount = 1.111e18; discountAmount = 0.111e18 * 0.5 = 0.0555e18
        //   rate ≈ 1.0555e18
        assertApproxEqRel(rate, 1.0555e18, 0.001e18);

        vm.prank(mainPool);
        money.transfer(alice, 100 ether);
        vm.prank(alice);
        money.approve(address(treasury), 100 ether);

        vm.roll(block.number + 1);
        vm.prank(alice);
        treasury.buyBonds(100 ether, price);

        // bondAmount = 100 * rate / 1e18 ≈ 105.55
        assertApproxEqRel(trustnote.balanceOf(alice), 105.55 ether, 0.001e18);
    }

    // =================================================================
    // RECOVERY EXPANSION — bond redemption at premium
    // =================================================================

    function test_Recovery_BondholderRedeemsAtPremium() public {
        _stakeAll();

        // 1. Initial expansion to seed Treasury MONEY reserves via seigniorageSaved.
        _allocateAtPrice(1.05e18);

        // 2. Contraction: alice buys bonds.
        oracle.setPrice(0.9e18);
        _allocateAtPrice(0.9e18);
        // Alice already has 10k MONEY from setUp.
        vm.prank(alice);
        money.approve(address(treasury), 50 ether);
        uint256 contractionPrice = treasury.getMoneyPrice();
        vm.roll(block.number + 1);
        vm.prank(alice);
        treasury.buyBonds(50 ether, contractionPrice);
        assertEq(trustnote.balanceOf(alice), 50 ether);

        // 3. Force a few more contraction epochs so seigniorageSaved < bondSupply
        //    (depletes the bond depletion floor), then snap above ceiling for
        //    a "recovery expansion" where the treasury saves MONEY to pay debt.
        oracle.setPrice(1.15e18); // above premium threshold (1.10e18)
        _allocateAtPrice(1.15e18);
        _allocateAtPrice(1.15e18);
        _allocateAtPrice(1.15e18);

        // At this point Treasury MONEY > 0 and price > ceiling. Alice can redeem.
        uint256 reserve = money.balanceOf(address(treasury));
        assertGt(reserve, 0);

        uint256 priceNow = treasury.getMoneyPrice();
        uint256 premiumRate = treasury.getBondPremiumRate();
        assertGt(premiumRate, 1e18); // premium kicks in above 1.10e18

        vm.prank(alice);
        trustnote.approve(address(treasury), 50 ether);
        uint256 moneyBefore = money.balanceOf(alice);
        vm.roll(block.number + 1);
        vm.prank(alice);
        treasury.redeemBonds(50 ether, priceNow);

        // Alice burned all 50 TRUSTNOTE; got MONEY = 50 * premiumRate / 1e18.
        assertEq(trustnote.balanceOf(alice), 0);
        assertApproxEqRel(money.balanceOf(alice) - moneyBefore, 50 ether * premiumRate / 1e18, 0.001e18);
    }

    function test_Recovery_RedeemBondsRejectsBelowCeiling() public {
        _stakeAll();
        _allocateAtPrice(1.05e18);

        oracle.setPrice(0.9e18);
        _allocateAtPrice(0.9e18);
        // Alice already has MONEY from setUp.
        vm.prank(alice);
        money.approve(address(treasury), 10 ether);
        uint256 contractionPrice = treasury.getMoneyPrice();
        vm.roll(block.number + 1);
        vm.prank(alice);
        treasury.buyBonds(10 ether, contractionPrice);

        // Drift sideways but still below ceiling.
        oracle.setPrice(1.0e18);
        vm.prank(alice);
        trustnote.approve(address(treasury), 10 ether);
        vm.roll(block.number + 1);
        vm.prank(alice);
        vm.expectRevert(Treasury.PriceNotEligible.selector);
        treasury.redeemBonds(10 ether, 1.0e18);
    }

    // =================================================================
    // EPOCH GATING
    // =================================================================

    function test_AllocateSeigniorage_RejectsBeforeEpoch() public {
        _stakeAll();
        // Advance one block past the last boardroom.stake — otherwise Boardroom's
        // onlyOneBlock guard rejects the chained boardroom.allocateSeigniorage call
        // from Treasury (bootstrap branch fires every epoch for epochs 0–27, which
        // routes through boardroom.allocateSeigniorage).
        vm.roll(block.number + 1);
        // No warp — block.timestamp == startTime+1, epoch=0, nextEpochPoint=startTime.
        // The first call IS allowed since nextEpochPoint() == startTime <= block.timestamp.
        // Call it once successfully…
        treasury.allocateSeigniorage();
        // …then the next call should fail (epoch advanced, next point is in the future).
        vm.roll(block.number + 1);
        vm.expectRevert(Treasury.NotEpochYet.selector);
        treasury.allocateSeigniorage();
    }

    function test_BuyBonds_RejectsZero() public {
        _stakeAll();
        _allocateAtPrice(1.05e18);
        oracle.setPrice(0.9e18);
        _allocateAtPrice(0.9e18);

        vm.roll(block.number + 1); // dodge onlyOneBlock from prior allocateSeigniorage
        vm.prank(alice);
        vm.expectRevert(Treasury.CannotPurchaseWithZero.selector);
        treasury.buyBonds(0, 0.9e18);
    }

    function test_BuyBonds_RejectsPriceMoved() public {
        _stakeAll();
        _allocateAtPrice(1.05e18);
        oracle.setPrice(0.9e18);
        _allocateAtPrice(0.9e18);

        vm.prank(mainPool);
        money.transfer(alice, 10 ether);
        vm.prank(alice);
        money.approve(address(treasury), 10 ether);

        vm.roll(block.number + 1);
        vm.prank(alice);
        // Alice expects price 0.95e18 but the live oracle says 0.9e18 → revert.
        vm.expectRevert(Treasury.PriceMoved.selector);
        treasury.buyBonds(10 ether, 0.95e18);
    }

    // =================================================================
    // Helpers
    // =================================================================

    function _stakeAll() internal {
        _stake(alice, 1000 ether);
        _stake(bob, 3000 ether);
        _stake(carol, 6000 ether);
    }

    function _stake(
        address who,
        uint256 amount
    ) internal {
        vm.roll(block.number + 1);
        vm.prank(who);
        estate.approve(address(boardroom), amount);
        vm.roll(block.number + 1);
        vm.prank(who);
        boardroom.stake(amount);
    }

    function _allocateAtPrice(
        uint256 price
    ) internal {
        oracle.setPrice(price);
        vm.warp(treasury.nextEpochPoint() + 1);
        vm.roll(block.number + 1);
        treasury.allocateSeigniorage();
    }
}
