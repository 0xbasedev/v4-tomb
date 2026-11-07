// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "../utils/BaseTest.sol";
import {IMasonryValidatedLevelTwap} from "../../src/masonry/MasonryCriticalDefense.sol";
import {IMasonryMintableLevel} from "../../src/masonry/IMasonryRuntime.sol";
import {MasonryBond} from "../../src/masonry/MasonryBond.sol";
import {MasonryChamber} from "../../src/masonry/MasonryChamber.sol";
import {MasonryTreasury} from "../../src/masonry/MasonryTreasury.sol";
import {MockLevel, MockLp, MockTwap} from "./MasonryTreasury.t.sol";

contract MasonryBondTest is BaseTest {
    // PLACEHOLDER caps — not approved tokenomics.
    uint16 internal constant MAX_DISCOUNT_BPS = 10_000;
    uint16 internal constant MAX_DEBT_RATIO_BPS = 3500;
    uint256 internal constant MAX_BOND_SUPPLY = 1_000_000 ether;

    MockLevel internal level;
    MockLp internal lp;
    MockTwap internal oracle;
    MasonryChamber internal chamber;
    MasonryTreasury internal treasury;
    MasonryBond internal bond;
    uint256 internal startTime;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        startTime = block.timestamp + 1 hours;
        level = new MockLevel();
        lp = new MockLp();
        oracle = new MockTwap();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        chamber = new MasonryChamber(IERC20(address(lp)), IERC20(address(level)), predicted);
        treasury =
            new MasonryTreasury(IMasonryMintableLevel(address(level)), chamber, oracle, startTime, 200, address(this));
        bond = new MasonryBond(
            IERC20(address(level)), treasury, oracle, MAX_DISCOUNT_BPS, MAX_DEBT_RATIO_BPS, MAX_BOND_SUPPLY
        );
        treasury.setBond(address(bond));
        level.mint(alice, 10_000 ether);
        vm.prank(alice);
        level.approve(address(bond), type(uint256).max);
    }

    function test_BuyBelowPegBurnsTombAndMintsBonds() public {
        oracle.set(0.5e18, block.timestamp, true);
        uint256 preview = bond.previewBuy(100 ether);
        // 0.5 peg → 2×, which equals the 100% discount cap.
        assertEq(preview, 200 ether);
        vm.prank(alice);
        bond.buy(100 ether);
        assertEq(bond.balanceOf(alice), 200 ether);
        assertEq(level.balanceOf(alice), 9900 ether);
        assertEq(level.totalSupply(), 9900 ether);
    }

    function test_CannotBuyAtOrAbovePeg() public {
        oracle.set(1e18, block.timestamp, true);
        vm.prank(alice);
        vm.expectRevert(MasonryBond.NotBelowPeg.selector);
        bond.buy(100 ether);
        oracle.set(1.02e18, block.timestamp, true);
        vm.prank(alice);
        vm.expectRevert(MasonryBond.NotBelowPeg.selector);
        bond.buy(100 ether);
    }

    function test_DiscountIsBoundedAt2x() public {
        oracle.set(0.1e18, block.timestamp, true);
        assertEq(bond.previewBuy(100 ether), 200 ether);
    }

    function test_DebtCapBlocksExcessBonds() public {
        oracle.set(0.5e18, block.timestamp, true);
        // circulatingAfter = 10000 - x; bonds = 2x; cap = 0.35 * (10000-x)
        // 2x <= 0.35*(10000-x) => 2x <= 3500 - 0.35x => 2.35x <= 3500 => x <= 1489.36
        vm.prank(alice);
        bond.buy(1489 ether);
        vm.prank(alice);
        vm.expectRevert(MasonryBond.DebtCap.selector);
        bond.buy(10 ether);
        assertLe(bond.totalSupply(), (level.totalSupply() * MAX_DEBT_RATIO_BPS) / 10_000);
    }

    function test_RedeemOnlyAbovePeg() public {
        oracle.set(0.8e18, block.timestamp, true);
        vm.prank(alice);
        bond.buy(100 ether);
        uint256 bondsHeld = bond.balanceOf(alice);

        vm.prank(alice);
        vm.expectRevert(MasonryBond.NotAbovePeg.selector);
        bond.redeem(bondsHeld);

        oracle.set(1e18, block.timestamp, true);
        vm.prank(alice);
        vm.expectRevert(MasonryBond.NotAbovePeg.selector);
        bond.redeem(bondsHeld);

        oracle.set(1.02e18, block.timestamp, true);
        uint256 tombBefore = level.balanceOf(alice);
        vm.prank(alice);
        bond.redeem(bondsHeld);
        assertEq(bond.balanceOf(alice), 0);
        assertEq(level.balanceOf(alice), tombBefore + bondsHeld);
    }

    function test_StaleOracleBlocksBuyAndRedeem() public {
        oracle.set(0.8e18, block.timestamp - 31 minutes, true);
        vm.prank(alice);
        vm.expectRevert(MasonryBond.StaleOracle.selector);
        bond.buy(10 ether);
    }
}
