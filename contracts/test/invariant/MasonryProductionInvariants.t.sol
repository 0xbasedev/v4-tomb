// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "../utils/BaseTest.sol";
import {IMasonryMintableLevel} from "../../src/masonry/IMasonryRuntime.sol";
import {MasonryBond} from "../../src/masonry/MasonryBond.sol";
import {MasonryChamber} from "../../src/masonry/MasonryChamber.sol";
import {MasonryFarm} from "../../src/masonry/MasonryFarm.sol";
import {DummyShareZapper} from "../utils/DummyShareZapper.sol";
import {MasonryRules} from "../../src/masonry/MasonryRules.sol";
import {MasonryTreasury} from "../../src/masonry/MasonryTreasury.sol";
import {MockLevel, MockLp, MockTwap} from "../unit/MasonryTreasury.t.sol";
import {MockShare, MockShareWethLp} from "../unit/MasonryFarm.t.sol";

contract MasonryProductionInvariantsTest is BaseTest {
    uint256 internal constant FARM_BUDGET = 25_641 ether;
    uint256 internal constant FARM_DURATION = 365 days;
    uint16 internal constant DEBT_RATIO = 3500;

    MockLevel internal level;
    MockLp internal lp;
    MockTwap internal oracle;
    MasonryChamber internal chamber;
    MasonryTreasury internal treasury;
    MasonryBond internal bond;
    MockShare internal share;
    MockShareWethLp internal shareLp;
    MasonryFarm internal farm;
    uint256 internal startTime;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        startTime = block.timestamp + 1 hours;
        level = new MockLevel();
        lp = new MockLp();
        oracle = new MockTwap();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        chamber = new MasonryChamber(
            IERC20(address(lp)), IERC20(address(level)), predicted, makeAddr("protocolTreasury"), makeAddr("arbitrage")
        );
        treasury = new MasonryTreasury(
            IMasonryMintableLevel(address(level)), chamber, oracle, startTime, 200, 30 minutes, address(this)
        );
        bond = new MasonryBond(
            IERC20(address(level)), treasury, oracle, 10_000, DEBT_RATIO, 1_000_000 ether, 0, 30 minutes
        );
        treasury.setBond(address(bond));
        share = new MockShare();
        shareLp = new MockShareWethLp();
        farm = new MasonryFarm(
            IERC20(address(share)),
            startTime,
            FARM_DURATION,
            FARM_BUDGET,
            address(this),
            IERC20(address(shareLp)),
            1000,
            MasonryFarm.Policy({
                claimToWallet: false,
                withdrawCooldown: 1800,
                daoWallet: makeAddr("daoWallet"),
                masonry: address(chamber),
                zapper: address(new DummyShareZapper())
            })
        );
        share.mint(address(this), FARM_BUDGET);
        share.approve(address(farm), FARM_BUDGET);
        farm.fund(FARM_BUDGET);
        level.mint(address(this), 1_000_000 ether);
        lp.mint(alice, 1000 ether);
        shareLp.mint(alice, 100 ether);
        vm.prank(alice);
        lp.approve(address(chamber), type(uint256).max);
        vm.prank(alice);
        chamber.stake(1000 ether);
        vm.prank(alice);
        shareLp.approve(address(farm), type(uint256).max);
        level.mint(bob, 50_000 ether);
        vm.prank(bob);
        level.approve(address(bond), type(uint256).max);
    }

    function testFuzz_NoMintAtOrBelowPeg(
        uint256 priceRaw,
        bool valid,
        uint256 ageRaw
    ) public {
        uint256 price = bound(priceRaw, 1, 1.01e18);
        uint256 age = bound(ageRaw, 0, 2 days);
        vm.warp(startTime + 1);
        oracle.set(price, block.timestamp - age, valid);
        uint256 supply = level.totalSupply();
        treasury.allocateExpansion();
        assertEq(level.totalSupply(), supply, "no mint at or below 1.01");
        assertEq(treasury.epoch(), 1);
    }

    function testFuzz_FarmEmissionsNeverExceedSchedule(
        uint256 elapsedRaw,
        uint256 depositRaw
    ) public {
        uint256 elapsed = bound(elapsedRaw, 0, FARM_DURATION + 30 days);
        uint256 depositAmount = bound(depositRaw, 1, 100 ether);
        vm.prank(alice);
        farm.deposit(0, depositAmount);
        vm.warp(startTime + elapsed);
        uint256 pending = farm.pending(0, alice);
        farm.update();
        pending = farm.pending(0, alice);
        assertLe(farm.emitted(), farm.entitledTo(block.timestamp));
        assertLe(farm.claimed(), farm.emitted());
        assertLe(farm.claimed(), FARM_BUDGET);
        assertLe(pending, FARM_BUDGET);
        assertEq(share.balanceOf(alice), 0, "farm X Share never pays the wallet");
        vm.prank(alice);
        vm.expectRevert(MasonryFarm.ClaimToWalletDisabled.selector);
        farm.harvest(0);
    }

    function testFuzz_BondDebtRespectsCaps(
        uint256 tombRaw,
        uint256 priceRaw
    ) public {
        uint256 price = bound(priceRaw, 0.05e18, 0.999e18);
        uint256 tombAmount = bound(tombRaw, 1 ether, 5000 ether);
        oracle.set(price, block.timestamp, true);
        uint256 preview = bond.previewBuy(tombAmount);
        uint256 circulatingAfter = level.totalSupply() - tombAmount;
        uint256 cap = circulatingAfter * DEBT_RATIO / 10_000;
        if (preview == 0 || bond.totalSupply() + preview > cap || bond.totalSupply() + preview > bond.maxBondSupply()) {
            vm.prank(bob);
            vm.expectRevert();
            bond.buy(tombAmount);
            return;
        }
        vm.prank(bob);
        bond.buy(tombAmount);
        assertLe(bond.totalSupply(), (level.totalSupply() * DEBT_RATIO) / 10_000);
        assertLe(bond.totalSupply(), bond.maxBondSupply());
        uint256 fair = tombAmount * 1e18 / price;
        uint256 maxOut = tombAmount * 2;
        assertLe(preview, maxOut);
        assertLe(preview, fair);
    }

    function testFuzz_FireTaxNeverExceeds12Percent(
        uint256 priceRaw,
        uint16 baselineRaw,
        uint16 maximumRaw,
        uint16 dropRaw,
        uint16 raisedRaw,
        uint256 elapsedRaw,
        uint16 projectedRaw
    ) public {
        uint256 peg = 1e18;
        uint256 price = bound(priceRaw, 0, 2e18);
        uint16 baseline = uint16(bound(baselineRaw, 0, 1200));
        uint16 maximum = uint16(bound(maximumRaw, baseline, 1200));
        uint16 drop = uint16(bound(dropRaw, 1, 10_000));
        uint16 target = MasonryRules.targetSellTaxBps(price, peg, baseline, maximum, drop);
        assertLe(target, MasonryRules.HARD_MAX_FIRE_TAX_BPS);

        uint16 raised = uint16(bound(raisedRaw, baseline, 1200));
        uint256 elapsed = bound(elapsedRaw, 0, 14 hours);
        uint16 floor = MasonryRules.recoveryFloorBps(raised, baseline, 1000, 1000 + elapsed);
        assertLe(floor, MasonryRules.HARD_MAX_FIRE_TAX_BPS);

        uint16 projected = uint16(bound(projectedRaw, 0, 1200));
        uint16 effective = MasonryRules.effectiveSellTaxBps(target, projected, floor);
        assertLe(effective, 1200);
    }
}
