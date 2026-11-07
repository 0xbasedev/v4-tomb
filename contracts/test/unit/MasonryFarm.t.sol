// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "../utils/BaseTest.sol";
import {MasonryFarm} from "../../src/masonry/MasonryFarm.sol";

contract MockShare is ERC20 {
    constructor() ERC20("X Share", "xSHARE") {}

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract MockShareWethLp is ERC20 {
    constructor() ERC20("X Share/WETH LP", "SLP") {}

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract MasonryFarmTest is BaseTest {
    // PLACEHOLDER values from config/masonry-launch.template.json
    uint256 internal constant BUDGET = 25_641 ether;
    uint256 internal constant DURATION = 365 days;

    MockShare internal share;
    MockShareWethLp internal lp;
    MasonryFarm internal farm;
    uint256 internal startTime;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        startTime = block.timestamp + 1 hours;
        share = new MockShare();
        lp = new MockShareWethLp();
        farm = new MasonryFarm(
            IERC20(address(share)), startTime, DURATION, BUDGET, address(this), IERC20(address(lp)), 1000
        );
        share.mint(address(this), BUDGET);
        share.approve(address(farm), BUDGET);
        farm.fund(BUDGET);
        lp.mint(alice, 100 ether);
        vm.prank(alice);
        lp.approve(address(farm), type(uint256).max);
    }

    function test_ConstructorWiresShareWethLpPool() public {
        assertEq(farm.poolLength(), 1);
        (IERC20 stake,, uint256 staked,,) = farm.pools(0);
        assertEq(address(stake), address(lp));
        assertEq(staked, 0);
        assertEq(farm.rewardBudget(), BUDGET);
        assertEq(farm.duration(), DURATION);
    }

    function test_EmissionsFollowLinearSchedule() public {
        vm.warp(startTime + 1);
        vm.prank(alice);
        farm.deposit(0, 100 ether);

        vm.warp(startTime + DURATION / 2);
        uint256 pending = farm.pending(0, alice);
        assertLe(pending, farm.entitledTo(block.timestamp));
        assertEq(farm.entitledTo(block.timestamp), BUDGET / 2);

        vm.prank(alice);
        farm.harvest(0);
        assertLe(farm.claimed(), farm.entitledTo(block.timestamp));
        assertLe(farm.emitted(), farm.entitledTo(block.timestamp));
        assertLe(farm.emitted(), BUDGET);
        assertEq(share.balanceOf(alice), farm.claimed());
    }

    function test_EmptyFarmDoesNotCatchUpLaterStakers() public {
        vm.warp(startTime + DURATION / 2);
        farm.harvest(0); // permissionless schedule advance via harvest? requires stake - use add dummy update
        // deposit after half the schedule: first deposit triggers _updateAll while empty
        vm.prank(alice);
        farm.deposit(0, 100 ether);
        assertEq(farm.emitted(), farm.entitledTo(block.timestamp));
        assertEq(farm.pending(0, alice), 0);

        vm.warp(startTime + DURATION / 2 + 1 days);
        uint256 pending = farm.pending(0, alice);
        assertGt(pending, 0);
        assertLe(pending, farm.entitledTo(block.timestamp) - farm.emitted());
    }

    function test_CannotOverFund() public {
        share.mint(address(this), 1);
        share.approve(address(farm), 1);
        vm.expectRevert(MasonryFarm.OverFunded.selector);
        farm.fund(1);
    }
}
