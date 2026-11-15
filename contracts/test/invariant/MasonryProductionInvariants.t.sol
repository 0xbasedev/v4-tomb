// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "../utils/BaseTest.sol";
import {IMasonryMintableLevel} from "../../src/masonry/IMasonryRuntime.sol";
import {MasonryChamber} from "../../src/masonry/MasonryChamber.sol";
import {MasonryFarm} from "../../src/masonry/MasonryFarm.sol";
import {DummyShareZapper} from "../utils/DummyShareZapper.sol";
import {MasonryRules} from "../../src/masonry/MasonryRules.sol";
import {MasonryTreasury} from "../../src/masonry/MasonryTreasury.sol";
import {MockLevel, MockLp, MockTwap} from "../unit/MasonryTreasury.t.sol";
import {MockShare, MockShareWethLp} from "../unit/MasonryFarm.t.sol";
import {MockFireTax} from "../utils/MockFireTax.sol";

contract MasonryProductionInvariantsTest is BaseTest {
    uint256 internal constant FARM_BUDGET = 25_641 ether;
    uint256 internal constant FARM_DURATION = 365 days;

    MockLevel internal level;
    MockLp internal lp;
    MockTwap internal oracle;
    MasonryChamber internal chamber;
    MasonryTreasury internal treasury;
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
        MockFireTax taxOracle = new MockFireTax();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        chamber = new MasonryChamber(
            IERC20(address(lp)),
            IERC20(address(level)),
            predicted,
            makeAddr("protocolTreasury"),
            makeAddr("arbitrage"),
            taxOracle
        );
        treasury = new MasonryTreasury(
            IMasonryMintableLevel(address(level)),
            chamber,
            oracle,
            startTime,
            200,
            30 minutes,
            address(this),
            IERC20(address(lp)),
            0,
            address(this)
        );
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
                zapper: address(new DummyShareZapper()),
                fireTax: new MockFireTax()
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

    function testFuzz_FireTaxNeverExceedsSixPercent(
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
        uint16 baseline = uint16(bound(baselineRaw, 0, 600));
        uint16 maximum = uint16(bound(maximumRaw, baseline, 600));
        uint16 drop = uint16(bound(dropRaw, 1, 10_000));
        uint16 target = MasonryRules.targetSellTaxBps(price, peg, baseline, maximum, drop);
        assertLe(target, MasonryRules.HARD_MAX_FIRE_TAX_BPS);

        uint16 raised = uint16(bound(raisedRaw, baseline, 600));
        uint256 elapsed = bound(elapsedRaw, 0, 14 hours);
        uint16 floor = MasonryRules.recoveryFloorBps(raised, baseline, 1000, 1000 + elapsed);
        assertLe(floor, MasonryRules.HARD_MAX_FIRE_TAX_BPS);

        uint16 projected = uint16(bound(projectedRaw, 0, 600));
        uint16 effective = MasonryRules.effectiveSellTaxBps(target, projected, floor);
        assertLe(effective, 600);
    }
}
