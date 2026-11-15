// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {MasonryGenesisSchedule} from "../../src/masonry/MasonryGenesisSchedule.sol";
import {MasonryGenesisPass} from "../../src/masonry/MasonryGenesisPass.sol";
import {MasonryShareSale} from "../../src/masonry/MasonryShareSale.sol";
import {MockMasonryUSDC} from "./MasonryGenesisLPBurnFee.t.sol";

contract MockSaleShare is ERC20("X Share", "xSHARE") {
    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract MasonryShareSaleTest is Test {
    MasonryShareSale private sale;
    MasonryGenesisPass private pass;
    MasonryGenesisSchedule private schedule;
    MockMasonryUSDC private usdc;
    MockSaleShare private share;
    address private constant TREASURY = address(0x7EA5);
    address private constant ALICE = address(0xA11CE);
    address private constant BOB = address(0xB0B);
    uint256 private constant WINDOW = 3 days;
    /// @dev One unlock step: six 6-hour protocol epochs.
    uint256 private constant EPOCH = 6 * 6 hours;
    uint256 private constant MAX = type(uint256).max;
    uint256 private open;

    function setUp() public {
        usdc = new MockMasonryUSDC();
        share = new MockSaleShare();
        schedule = new MasonryGenesisSchedule(block.timestamp + 2 days, address(this));
        pass = new MasonryGenesisPass(usdc, TREASURY, schedule);
        pass.setSaleOpen(true);
        sale = new MasonryShareSale(share, pass, 20, 5, 1, 100e6, 5e6, WINDOW, EPOCH, 60e6);
        share.mint(address(sale), 100 ether);
        open = schedule.end();
        _member(ALICE);
        _member(BOB);
    }

    function _member(
        address who
    ) private {
        usdc.mint(who, 100_000e6);
        vm.startPrank(who);
        usdc.approve(address(pass), type(uint256).max);
        pass.purchase(MasonryGenesisPass.Tier.Genesis);
        usdc.approve(address(sale), type(uint256).max);
        sale.buyAuctionPass();
        vm.stopPrank();
    }

    function _buy(
        address who
    ) private returns (uint256) {
        vm.prank(who);
        return sale.buy(MAX);
    }

    function testFirstTrancheIsFiveSharesAt100ThenThePriceStepsUpBy5() public {
        vm.warp(open);
        assertEq(sale.pricePerShare(), 100e6);
        assertEq(sale.quote(), 500e6);
        uint256 t0 = usdc.balanceOf(TREASURY);
        assertEq(_buy(ALICE), 500e6);
        assertEq(usdc.balanceOf(TREASURY) - t0, 500e6);
        assertEq(usdc.balanceOf(address(sale)), 0, "sale never holds USDC");
        assertEq(share.balanceOf(ALICE), 1 ether, "one share now");
        assertEq(sale.vestingOf(ALICE), 4, "four vest");
        assertEq(sale.boughtBy(ALICE), 5);
        assertEq(sale.sold(), 5);
        assertEq(sale.pricePerShare(), 105e6);
        assertEq(sale.quote(), 525e6);
    }

    function testSameWalletCannotBuyTwoTranchesInARow() public {
        vm.warp(open);
        _buy(ALICE);
        assertFalse(sale.canBuy(ALICE));
        assertTrue(sale.canBuy(BOB));
        vm.prank(ALICE);
        vm.expectRevert(MasonryShareSale.WaitForAnotherBuyer.selector);
        sale.buy(MAX);
        _buy(BOB);
        assertTrue(sale.canBuy(ALICE), "unlocked once someone else has bought");
        _buy(ALICE);
        assertEq(sale.boughtBy(ALICE), 10);
        assertEq(sale.lastBuyer(), ALICE);
    }

    function testClosedBeforeGenesisEndsAndAfterTheWindow() public {
        vm.warp(open - 1);
        vm.prank(ALICE);
        vm.expectRevert(MasonryShareSale.NotOpen.selector);
        sale.buy(MAX);
        vm.warp(open + WINDOW);
        vm.prank(ALICE);
        vm.expectRevert(MasonryShareSale.NotOpen.selector);
        sale.buy(MAX);
    }

    function testNoNewPassesOnceTheSaleIsOpen() public {
        // Passes stop selling when Genesis ends, which is exactly when this sale
        // opens: only wallets that already hold a pass can ever buy.
        vm.warp(open);
        address late = address(0x1A7E);
        usdc.mint(late, 1000e6);
        vm.startPrank(late);
        usdc.approve(address(pass), type(uint256).max);
        vm.expectRevert(MasonryGenesisPass.InvalidPurchase.selector);
        pass.purchase(MasonryGenesisPass.Tier.Genesis);
        vm.stopPrank();
    }

    function testAuctionPassCosts60OnceAndIsRequired() public {
        address carol = address(0xCA201);
        usdc.mint(carol, 100_000e6);
        vm.startPrank(carol);
        usdc.approve(address(pass), type(uint256).max);
        pass.purchase(MasonryGenesisPass.Tier.Genesis);
        usdc.approve(address(sale), type(uint256).max);
        vm.stopPrank();
        vm.warp(open);
        assertFalse(sale.canBuy(carol));
        vm.prank(carol);
        vm.expectRevert(MasonryShareSale.AuctionPassRequired.selector);
        sale.buy(MAX);

        uint256 t0 = usdc.balanceOf(TREASURY);
        uint256 sold0 = sale.auctionPassesSold();
        vm.prank(carol);
        sale.buyAuctionPass();
        assertEq(usdc.balanceOf(TREASURY) - t0, 60e6, "fee goes to the treasury");
        assertEq(sale.auctionPassesSold(), sold0 + 1);
        assertTrue(sale.hasAuctionPass(carol));
        vm.prank(carol);
        vm.expectRevert(MasonryShareSale.AlreadyHasAuctionPass.selector);
        sale.buyAuctionPass();
        assertEq(_buy(carol), 500e6);
    }

    function testAuctionPassNeedsAGenesisPassAndStopsWhenTheSaleIsOver() public {
        address stranger = address(0x5713);
        usdc.mint(stranger, 1000e6);
        vm.startPrank(stranger);
        usdc.approve(address(sale), type(uint256).max);
        vm.expectRevert(MasonryShareSale.PassRequired.selector);
        sale.buyAuctionPass();
        vm.stopPrank();

        address dave = address(0xDA7E);
        usdc.mint(dave, 1000e6);
        vm.startPrank(dave);
        usdc.approve(address(pass), type(uint256).max);
        pass.purchase(MasonryGenesisPass.Tier.Genesis);
        usdc.approve(address(sale), type(uint256).max);
        vm.warp(open + WINDOW);
        vm.expectRevert(MasonryShareSale.SaleOver.selector);
        sale.buyAuctionPass();
        vm.stopPrank();
    }

    function testPassRequired() public {
        vm.warp(open);
        address stranger = address(0x5712);
        usdc.mint(stranger, 1000e6);
        vm.startPrank(stranger);
        usdc.approve(address(sale), type(uint256).max);
        vm.expectRevert(MasonryShareSale.PassRequired.selector);
        sale.buy(MAX);
        vm.stopPrank();
        assertFalse(sale.canBuy(stranger));
    }

    function testMaxCostProtectsAgainstBeingFrontRun() public {
        vm.warp(open);
        uint256 quoted = sale.quote();
        _buy(BOB);
        vm.prank(ALICE);
        vm.expectRevert(MasonryShareSale.CostAboveMax.selector);
        sale.buy(quoted);
    }

    function testTwentyTranchesSellOutAtExactly14750() public {
        vm.warp(open);
        uint256 t0 = usdc.balanceOf(TREASURY);
        uint256 paid;
        for (uint256 i; i < 20; ++i) {
            uint256 cost = _buy(i % 2 == 0 ? ALICE : BOB);
            assertEq(cost, 5 * (100e6 + i * 5e6), "five shares at this tranche's price");
            paid += cost;
        }
        assertEq(sale.pricePerShare(), 200e6, "the last tranche sold at 195");
        assertEq(paid, 14_750e6);
        assertEq(usdc.balanceOf(TREASURY) - t0, 14_750e6);
        assertEq(sale.sold(), 100);
        assertEq(sale.owedToBuyers(), 80 ether);
        assertEq(share.balanceOf(address(sale)), 80 ether, "4 of every 5 held for vesting");
        assertEq(share.balanceOf(ALICE) + share.balanceOf(BOB), 20 ether, "1 of every 5 paid at purchase");
        assertFalse(sale.isOpen());
        vm.prank(ALICE);
        vm.expectRevert(MasonryShareSale.NotOpen.selector);
        sale.buy(MAX);
    }

    function testRejectsEmptyConfiguration() public {
        vm.expectRevert(MasonryShareSale.InvalidConfiguration.selector);
        new MasonryShareSale(share, pass, 0, 5, 1, 100e6, 5e6, WINDOW, EPOCH, 60e6);
        vm.expectRevert(MasonryShareSale.InvalidConfiguration.selector);
        new MasonryShareSale(share, pass, 20, 0, 0, 100e6, 5e6, WINDOW, EPOCH, 60e6);
    }

    function testUnfundedSaleReverts() public {
        MasonryShareSale empty = new MasonryShareSale(share, pass, 20, 5, 1, 100e6, 5e6, WINDOW, EPOCH, 60e6);
        vm.warp(open);
        vm.startPrank(ALICE);
        usdc.approve(address(empty), type(uint256).max);
        empty.buyAuctionPass();
        vm.expectRevert(MasonryShareSale.NotFunded.selector);
        empty.buy(MAX);
        vm.stopPrank();
    }

    function testSweepTakesOnlyUnsoldSharesAndOnlyAfterTheWindow() public {
        vm.warp(open);
        _buy(ALICE);
        vm.expectRevert(MasonryShareSale.StillOpen.selector);
        sale.sweepUnsold();
        vm.warp(open + WINDOW);
        vm.prank(BOB);
        sale.sweepUnsold();
        assertEq(share.balanceOf(TREASURY), 95 ether);
        assertEq(share.balanceOf(address(sale)), 4 ether, "Alice's vesting shares stay put");
        sale.sweepUnsold();
        assertEq(share.balanceOf(TREASURY), 95 ether, "a second sweep takes nothing");
    }

    function testOneTrancheUnlocksPerEpoch() public {
        vm.warp(open);
        _buy(ALICE);
        _buy(BOB);
        _buy(ALICE);
        _buy(BOB);
        _buy(ALICE);
        assertEq(share.balanceOf(ALICE), 3 ether, "one per tranche at purchase");
        assertEq(sale.vestingOf(ALICE), 12);
        uint256 begin = open + WINDOW;
        assertEq(sale.vestingStart(), begin);

        vm.warp(begin + EPOCH - 1);
        assertEq(sale.claimable(ALICE), 0);
        vm.prank(ALICE);
        vm.expectRevert(MasonryShareSale.NothingToClaim.selector);
        sale.claim();

        vm.warp(begin + EPOCH);
        assertEq(sale.claimable(ALICE), 4 ether, "first tranche's four");
        assertEq(sale.claimable(BOB), 4 ether);
        vm.prank(ALICE);
        assertEq(sale.claim(), 4 ether);
        assertEq(sale.claimable(ALICE), 0);

        vm.warp(begin + 2 * EPOCH);
        assertEq(sale.claimable(ALICE), 4 ether, "second tranche's four");
        assertEq(sale.claimable(BOB), 8 ether, "Bob bought two and has claimed nothing");

        vm.warp(begin + 3 * EPOCH);
        assertEq(sale.claimable(ALICE), 8 ether);
        assertEq(sale.claimable(BOB), 8 ether, "Bob is fully unlocked after two epochs");

        vm.warp(begin + 50 * EPOCH);
        vm.prank(ALICE);
        sale.claim();
        vm.prank(BOB);
        sale.claim();
        assertEq(share.balanceOf(ALICE), 15 ether);
        assertEq(share.balanceOf(BOB), 10 ether);
        assertEq(sale.owedToBuyers(), 0);
        vm.prank(ALICE);
        vm.expectRevert(MasonryShareSale.NothingToClaim.selector);
        sale.claim();
    }

    function testUpfrontCannotExceedTheTranche() public {
        vm.expectRevert(MasonryShareSale.InvalidConfiguration.selector);
        new MasonryShareSale(share, pass, 20, 5, 6, 100e6, 5e6, WINDOW, EPOCH, 60e6);
    }

    function testSweepAndClaimsNeverStarveEachOther() public {
        vm.warp(open);
        _buy(ALICE);
        _buy(BOB);
        _buy(ALICE);
        vm.warp(open + WINDOW + EPOCH);
        vm.prank(ALICE);
        sale.claim();
        sale.sweepUnsold();
        assertEq(share.balanceOf(TREASURY), 85 ether);
        vm.warp(open + WINDOW + 2 * EPOCH);
        vm.prank(ALICE);
        sale.claim();
        vm.prank(BOB);
        sale.claim();
        assertEq(share.balanceOf(ALICE), 10 ether);
        assertEq(share.balanceOf(BOB), 5 ether);
        assertEq(share.balanceOf(address(sale)), 0);
    }
}
