// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";
import {MockOracle} from "../utils/MockOracle.sol";

import {Treasury} from "../../src/core/Treasury.sol";
import {Masonry} from "../../src/core/Masonry.sol";
import {PegToken} from "../../src/tokens/PegToken.sol";
import {ShareToken} from "../../src/tokens/ShareToken.sol";
import {ITreasury} from "../../src/interfaces/ITreasury.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @notice The Treasury as an emissions engine: it mints expansion above the ceiling and
 *         does nothing else. No bonds, no reserve, no bootstrap, no balance of its own.
 */
contract TreasuryTest is BaseTest {
    Treasury internal treasury;
    Masonry internal masonry;
    PegToken internal peg;
    ShareToken internal share;
    MockOracle internal oracle;

    address internal communityFund = makeAddr("communityFund");
    address internal devFund = makeAddr("devFund");
    address internal daoFund = makeAddr("daoFund");
    address internal farm = makeAddr("farm");

    uint256 internal startTime;
    uint256 internal constant CIRCULATING = 100_000 ether;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        startTime = block.timestamp + 1 hours;

        vm.startPrank(owner);
        peg = new PegToken("Peg Token", "PEG");
        share = new ShareToken("Share Token", "SHARE", startTime, communityFund, devFund);
        oracle = new MockOracle(1e18);
        treasury = new Treasury();
        masonry = new Masonry();
        masonry.initialize(IERC20(address(peg)), IERC20(address(share)), ITreasury(address(treasury)));

        address[] memory excluded = new address[](1);
        excluded[0] = farm;
        treasury.initialize(address(peg), address(share), address(oracle), address(masonry), startTime, excluded);

        // Circulating supply for the expansion maths, plus an excluded farm balance.
        peg.mint(alice, CIRCULATING - 1 ether); // the constructor already minted 1 to owner
        peg.mint(farm, 40_000 ether);
        share.distributeReward(bob);

        peg.transferTrustees(address(treasury));
        share.transferTrustees(address(treasury));
        masonry.setOperator(address(treasury));
        vm.stopPrank();
    }

    function _stake(
        address who,
        uint256 amount
    ) internal {
        vm.prank(bob);
        share.transfer(who, amount);
        vm.startPrank(who);
        share.approve(address(masonry), amount);
        vm.roll(block.number + 1);
        masonry.stake(amount);
        vm.stopPrank();
    }

    function _tick(
        uint256 price
    ) internal {
        oracle.setPrice(price);
        vm.warp(treasury.nextEpochPoint() + 1);
        vm.roll(block.number + 1);
        treasury.allocateSeigniorage();
    }

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------

    function test_Initialize_StoresWiringAndDefaults() public view {
        assertEq(treasury.peg(), address(peg));
        assertEq(treasury.share(), address(share));
        assertEq(treasury.oracle(), address(oracle));
        assertEq(treasury.masonry(), address(masonry));
        assertEq(treasury.startTime(), startTime);
        assertEq(treasury.operator(), owner);
        assertTrue(treasury.isInitialized());
        assertEq(treasury.pegPriceOne(), 1e18);
        assertEq(treasury.pegPriceCeiling(), 1.01e18);
        assertEq(treasury.supplyTiers(8), 50_000_000 ether);
        assertEq(treasury.maxExpansionTiers(0), 450);
        assertEq(treasury.maxExpansionTiers(8), 100);
        assertEq(treasury.epoch(), 0);
    }

    function test_Initialize_OnlyOnce() public {
        address[] memory none = new address[](0);
        vm.expectRevert(Treasury.AlreadyInitialized.selector);
        treasury.initialize(address(peg), address(share), address(oracle), address(masonry), startTime, none);
    }

    function test_CirculatingSupply_LeavesOutOnlyTheExcludedList() public view {
        assertEq(treasury.getPegCirculatingSupply(), CIRCULATING, "farm balance excluded, everything else counts");
    }

    // ------------------------------------------------------------------
    // Epoch clock
    // ------------------------------------------------------------------

    function test_Allocate_RejectsBeforeStart() public {
        vm.expectRevert(Treasury.NotStarted.selector);
        treasury.allocateSeigniorage();
    }

    function test_Allocate_RejectsBeforeTheNextEpoch() public {
        _stake(carol, 100 ether);
        _tick(1e18);
        vm.roll(block.number + 1);
        vm.expectRevert(Treasury.NotEpochYet.selector);
        treasury.allocateSeigniorage();
    }

    function test_Allocate_RequiresTreasuryToHoldItsRoles() public {
        vm.prank(owner);
        treasury.masonrySetOperator(stranger);
        vm.warp(treasury.nextEpochPoint() + 1);
        vm.roll(block.number + 1);
        vm.expectRevert(Treasury.InsufficientPermissions.selector);
        treasury.allocateSeigniorage();
    }

    // ------------------------------------------------------------------
    // No bootstrap: epoch 0 is earned by price like every other epoch
    // ------------------------------------------------------------------

    function test_NoBootstrap_EpochZeroAtPegMintsNothing() public {
        _stake(carol, 100 ether);
        uint256 supplyBefore = peg.totalSupply();
        _tick(1e18);
        assertEq(treasury.epoch(), 1);
        assertEq(peg.totalSupply(), supplyBefore, "no guaranteed emission");
        assertEq(masonry.earned(carol), 0);
    }

    // ------------------------------------------------------------------
    // Expansion
    // ------------------------------------------------------------------

    function test_Expansion_MintsPriceOverPegOfCirculatingSupplyToTheMasonry() public {
        _stake(carol, 100 ether);
        uint256 supplyBefore = peg.totalSupply();

        _tick(1.03e18); // 3% over peg, under the 4.5% tier cap

        uint256 expected = CIRCULATING * 3 / 100;
        assertEq(peg.totalSupply() - supplyBefore, expected, "3% of circulating supply");
        assertEq(peg.balanceOf(address(masonry)), expected, "all of it to the Masonry");
        assertApproxEqAbs(masonry.earned(carol), expected, 1e6);
    }

    function test_Expansion_IsCappedByTheSupplyTier() public {
        _stake(carol, 100 ether);
        uint256 supplyBefore = peg.totalSupply();
        _tick(1.5e18); // 50% over peg; tier 0 caps at 4.5%
        assertEq(peg.totalSupply() - supplyBefore, CIRCULATING * 450 / 10_000);
        assertEq(treasury.maxSupplyExpansionPercent(), 450);
    }

    function test_Expansion_ViewMatchesWhatIsMinted() public {
        _stake(carol, 100 ether);
        oracle.setPrice(1.02e18);
        uint256 preview = treasury.getExpansionAmount();
        uint256 supplyBefore = peg.totalSupply();
        _tick(1.02e18);
        assertEq(peg.totalSupply() - supplyBefore, preview);
        oracle.setPrice(1.01e18);
        assertEq(treasury.getExpansionAmount(), 0, "nothing at the ceiling");
    }

    function test_Expansion_PaysTheFundCutsFirst() public {
        _stake(carol, 100 ether);
        vm.prank(owner);
        treasury.setExtraFunds(daoFund, 2000, devFund, 500);

        _tick(1.04e18);

        uint256 total = CIRCULATING * 4 / 100;
        assertEq(peg.balanceOf(daoFund), total * 2000 / 10_000, "20% to the DAO");
        assertEq(peg.balanceOf(devFund), total * 500 / 10_000, "5% to dev");
        assertEq(peg.balanceOf(address(masonry)), total - total * 2500 / 10_000, "the rest to the Masonry");
    }

    function test_Expansion_WithAnEmptyMasonry_IsSkippedNotReverted() public {
        uint256 supplyBefore = peg.totalSupply();
        _tick(1.05e18);
        assertEq(treasury.epoch(), 1, "the clock still advances");
        assertEq(peg.totalSupply(), supplyBefore, "nothing minted with nobody to pay");

        // Once someone stakes, the next expansion pays normally.
        _stake(carol, 100 ether);
        _tick(1.05e18);
        assertGt(masonry.earned(carol), 0);
    }

    // ------------------------------------------------------------------
    // No bonds, no debt, no reserve
    // ------------------------------------------------------------------

    function test_Contraction_MintsNothing_AndLeavesNoDebt() public {
        _stake(carol, 100 ether);
        uint256 supplyBefore = peg.totalSupply();
        _tick(0.8e18);
        _tick(0.6e18);
        assertEq(peg.totalSupply(), supplyBefore);
        assertEq(peg.balanceOf(address(treasury)), 0);
    }

    function test_Recovery_ExpandsInFullOnTheFirstEpochBackAboveTheCeiling() public {
        _stake(carol, 100 ether);
        _tick(0.7e18);
        _tick(0.7e18);

        // Nothing is owed to anyone, so the whole expansion reaches the Masonry at once.
        uint256 supplyBefore = peg.totalSupply();
        _tick(1.03e18);
        uint256 minted = peg.totalSupply() - supplyBefore;
        assertEq(minted, CIRCULATING * 3 / 100);
        assertEq(peg.balanceOf(address(masonry)), minted);
    }

    function test_Treasury_NeverHoldsABalance() public {
        _stake(carol, 100 ether);
        vm.prank(owner);
        treasury.setExtraFunds(daoFund, 1500, devFund, 500);
        uint256[6] memory prices = [uint256(1.05e18), 0.9e18, 1.2e18, 1.0e18, 1.011e18, 2e18];
        for (uint256 i = 0; i < prices.length; ++i) {
            _tick(prices[i]);
            assertEq(peg.balanceOf(address(treasury)), 0, "everything minted leaves in the same call");
        }
    }

    function test_Recover_SweepsAnythingSentByMistake_IncludingThePegToken() public {
        vm.prank(alice);
        peg.transfer(address(treasury), 5 ether);

        vm.prank(stranger);
        vm.expectRevert(Treasury.NotOperator.selector);
        treasury.governanceRecoverUnsupported(IERC20(address(peg)), 5 ether, daoFund);

        vm.prank(owner);
        treasury.governanceRecoverUnsupported(IERC20(address(peg)), 5 ether, daoFund);
        assertEq(peg.balanceOf(daoFund), 5 ether);
        assertEq(peg.balanceOf(address(treasury)), 0);
    }

    // ------------------------------------------------------------------
    // Setters: operator only, bounded
    // ------------------------------------------------------------------

    function test_Setters_AreOperatorOnly() public {
        vm.startPrank(stranger);
        vm.expectRevert(Treasury.NotOperator.selector);
        treasury.setOperator(stranger);
        vm.expectRevert(Treasury.NotOperator.selector);
        treasury.setOracle(stranger);
        vm.expectRevert(Treasury.NotOperator.selector);
        treasury.setMasonry(stranger);
        vm.expectRevert(Treasury.NotOperator.selector);
        treasury.setPegPriceCeiling(1.05e18);
        vm.expectRevert(Treasury.NotOperator.selector);
        treasury.setExtraFunds(daoFund, 1, devFund, 1);
        vm.expectRevert(Treasury.NotOperator.selector);
        treasury.setMaxExpansionTiersEntry(0, 100);
        vm.stopPrank();
    }

    function test_Setters_AreBounded() public {
        vm.startPrank(owner);
        vm.expectRevert(Treasury.CeilingOutOfRange.selector);
        treasury.setPegPriceCeiling(1e18 - 1);
        vm.expectRevert(Treasury.CeilingOutOfRange.selector);
        treasury.setPegPriceCeiling(1.2e18 + 1);
        vm.expectRevert(Treasury.ExpansionPercentOutOfRange.selector);
        treasury.setMaxSupplyExpansionPercents(1001);
        vm.expectRevert(Treasury.ExpansionPercentOutOfRange.selector);
        treasury.setMaxExpansionTiersEntry(0, 1001);
        vm.expectRevert(Treasury.TierIndexOutOfRange.selector);
        treasury.setSupplyTiersEntry(9, 1);
        vm.expectRevert(Treasury.TierValueNotMonotonic.selector);
        treasury.setSupplyTiersEntry(1, 0);
        vm.expectRevert(Treasury.FundShareOutOfRange.selector);
        treasury.setExtraFunds(daoFund, 3001, devFund, 0);
        vm.expectRevert(Treasury.FundShareOutOfRange.selector);
        treasury.setExtraFunds(daoFund, 0, devFund, 1001);
        vm.expectRevert(Treasury.ZeroAddress.selector);
        treasury.setExtraFunds(address(0), 0, devFund, 0);

        treasury.setPegPriceCeiling(1.05e18);
        assertEq(treasury.pegPriceCeiling(), 1.05e18);
        vm.stopPrank();
    }

    function testFuzz_Expansion_NeverExceedsTheTierCap_AndLeavesNothingBehind(
        uint256 price,
        uint16 daoBps,
        uint16 devBps
    ) public {
        price = bound(price, 0.2e18, 5e18);
        _stake(carol, 100 ether);
        vm.prank(owner);
        treasury.setExtraFunds(daoFund, bound(daoBps, 0, 3000), devFund, bound(devBps, 0, 1000));

        uint256 supplyBefore = peg.totalSupply();
        _tick(price);
        uint256 minted = peg.totalSupply() - supplyBefore;

        assertLe(minted, CIRCULATING * 450 / 10_000, "tier cap");
        if (price <= 1.01e18) assertEq(minted, 0, "nothing at or below the ceiling");
        assertEq(peg.balanceOf(daoFund) + peg.balanceOf(devFund) + peg.balanceOf(address(masonry)), minted);
        assertEq(peg.balanceOf(address(treasury)), 0);
    }
}
