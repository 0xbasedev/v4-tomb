// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "../utils/BaseTest.sol";
import {IMasonryValidatedLevelTwap} from "../../src/masonry/MasonryCriticalDefense.sol";
import {IMasonryMintableLevel} from "../../src/masonry/IMasonryRuntime.sol";
import {MasonryBond} from "../../src/masonry/MasonryBond.sol";
import {MasonryChamber} from "../../src/masonry/MasonryChamber.sol";
import {MasonryTreasury} from "../../src/masonry/MasonryTreasury.sol";

contract MockLevel is ERC20Burnable {
    constructor() ERC20("X Tomb", "xTOMB") {}

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract MockLp is ERC20 {
    constructor() ERC20("X Share/WETH LP", "SLP") {}

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract MockTwap is IMasonryValidatedLevelTwap {
    uint256 public price = 1e18;
    uint256 public observedAt;
    bool public valid = true;

    function latestValidatedTwap() external view returns (uint256, uint256, bool) {
        return (price, observedAt == 0 ? block.timestamp : observedAt, valid);
    }

    function set(
        uint256 price_,
        uint256 observedAt_,
        bool valid_
    ) external {
        price = price_;
        observedAt = observedAt_;
        valid = valid_;
    }
}

contract MasonryTreasuryTest is BaseTest {
    MockLevel internal level;
    MockLp internal lp;
    MockTwap internal oracle;
    MasonryChamber internal chamber;
    MasonryTreasury internal treasury;
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
        assertEq(address(treasury), predicted);
        level.mint(address(this), 1_000_000 ether);
        lp.mint(alice, 1000 ether);
    }

    function _stakeAlice() internal {
        vm.startPrank(alice);
        lp.approve(address(chamber), type(uint256).max);
        chamber.stake(1000 ether);
        vm.stopPrank();
    }

    function test_NoMintAtOrBelowPeg() public {
        _stakeAlice();
        vm.warp(startTime + 1);
        uint256 supply = level.totalSupply();
        oracle.set(1e18, block.timestamp, true);
        treasury.allocateExpansion();
        assertEq(level.totalSupply(), supply);
        assertEq(treasury.epoch(), 1);

        vm.warp(treasury.nextEpochPoint() + 1);
        oracle.set(1.01e18, block.timestamp, true);
        treasury.allocateExpansion();
        assertEq(level.totalSupply(), supply);
        assertEq(treasury.epoch(), 2);
    }

    function test_MintsWhenFreshTwapStrictlyAboveCeiling() public {
        _stakeAlice();
        vm.warp(startTime + 1);
        oracle.set(1.02e18, block.timestamp, true);
        uint256 supply = level.totalSupply();
        treasury.allocateExpansion();
        assertEq(level.totalSupply(), supply + supply * 200 / 10_000);
        assertEq(chamber.pending(alice), supply * 200 / 10_000);
    }

    function test_StaleOracleSkipsMintAndAdvancesEpoch() public {
        _stakeAlice();
        vm.warp(startTime + 1);
        oracle.set(1.05e18, block.timestamp - 31 minutes, true);
        uint256 supply = level.totalSupply();
        treasury.allocateExpansion();
        assertEq(level.totalSupply(), supply);
        assertEq(treasury.epoch(), 1);
    }

    function test_MissedEpochsDoNotCatchUpMint() public {
        _stakeAlice();
        vm.warp(startTime + 1);
        oracle.set(1.05e18, block.timestamp, true);
        uint256 supply = level.totalSupply();
        treasury.allocateExpansion();
        uint256 afterFirst = level.totalSupply();
        assertEq(afterFirst, supply + supply * 200 / 10_000);

        vm.warp(startTime + 13 hours);
        oracle.set(1.05e18, block.timestamp, true);
        treasury.allocateExpansion();
        uint256 circulating = afterFirst;
        assertEq(level.totalSupply(), circulating + circulating * 200 / 10_000);
        assertEq(treasury.epoch(), (13 hours) / treasury.PERIOD() + 1);
    }

    function test_EmptyMasonryDoesNotBrickEpoch() public {
        vm.warp(startTime + 1);
        oracle.set(1.05e18, block.timestamp, true);
        uint256 supply = level.totalSupply();
        treasury.allocateExpansion();
        assertEq(level.totalSupply(), supply);
        assertEq(treasury.epoch(), 1);
        vm.warp(treasury.nextEpochPoint() + 1);
        treasury.allocateExpansion();
        assertEq(treasury.epoch(), 2);
    }

    function test_RequestedRateCap() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        MasonryChamber next = new MasonryChamber(
            IERC20(address(lp)), IERC20(address(level)), predicted, makeAddr("protocolTreasury"), makeAddr("arbitrage")
        );
        vm.expectRevert(MasonryTreasury.InvalidConfiguration.selector);
        new MasonryTreasury(
            IMasonryMintableLevel(address(level)), next, oracle, startTime, 201, 30 minutes, address(this)
        );
    }

    function test_OracleAgeCap() public {
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        MasonryChamber next = new MasonryChamber(
            IERC20(address(lp)), IERC20(address(level)), predicted, makeAddr("protocolTreasury"), makeAddr("arbitrage")
        );
        vm.expectRevert(MasonryTreasury.InvalidConfiguration.selector);
        new MasonryTreasury(
            IMasonryMintableLevel(address(level)), next, oracle, startTime, 200, 30 minutes + 1, address(this)
        );
    }
}
