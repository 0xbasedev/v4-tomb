// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {MasonryGenesisSchedule} from "../../src/masonry/MasonryGenesisSchedule.sol";
import {MasonryGenesisPass} from "../../src/masonry/MasonryGenesisPass.sol";
import {MasonryGenesisStaking, IMasonryGenesisSettlement} from "../../src/masonry/MasonryGenesisStaking.sol";
import {
    MasonryGenesisLPBurnFee,
    IMasonryBurnableLevel,
    IMasonryRedeemableLPVault
} from "../../src/masonry/MasonryGenesisLPBurnFee.sol";
import {
    MockMasonryLevel,
    MockMasonryUSDC,
    MockMasonryRedeemableVault,
    MockMasonryV4Router,
    MockMasonryBurnGuard
} from "./MasonryGenesisLPBurnFee.t.sol";

contract MockGenesisSettlement is IMasonryGenesisSettlement {
    MockMasonryLevel private immutable level;
    MockMasonryRedeemableVault private immutable vault;

    constructor(
        MockMasonryLevel level_,
        MockMasonryRedeemableVault vault_
    ) {
        level = level_;
        vault = vault_;
    }

    function settle(
        address beneficiary,
        uint256 reward,
        bool compound,
        bool
    ) external {
        if (compound) {
            level.burn(reward);
            vault.mintShares(msg.sender, reward);
        } else {
            level.transfer(beneficiary, reward);
        }
    }
}

contract MasonryGenesisStakingTest is Test {
    MasonryGenesisSchedule private schedule;
    MasonryGenesisPass private pass;
    MasonryGenesisStaking private staking;
    MasonryGenesisLPBurnFee private fee;
    MockMasonryLevel private level;
    MockMasonryUSDC private usdc;
    MockMasonryRedeemableVault private vault;
    address private constant TREASURY = address(0x777);
    address private constant BASIC = address(0x111);
    address private constant PRO = address(0x222);
    address private constant ULTRA = address(0x333);
    address private constant KEEPER = address(0x444);

    function setUp() public {
        level = new MockMasonryLevel();
        usdc = new MockMasonryUSDC();
        vault = new MockMasonryRedeemableVault(level, usdc);
        schedule = new MasonryGenesisSchedule(block.timestamp + 2 days);
        pass = new MasonryGenesisPass(usdc, TREASURY, schedule);
        address c0 = address(level) < address(usdc) ? address(level) : address(usdc);
        address c1 = address(level) < address(usdc) ? address(usdc) : address(level);
        PoolKey memory key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), 3000, 60, IHooks(address(0)));
        vault.setPoolKey(key);
        MockMasonryBurnGuard guard = new MockMasonryBurnGuard();
        guard.setPoolKey(key);
        fee = new MasonryGenesisLPBurnFee(
            IMasonryRedeemableLPVault(address(vault)),
            IMasonryBurnableLevel(address(level)),
            usdc,
            new MockMasonryV4Router(level, usdc),
            guard,
            key,
            address(this),
            10_000e18,
            10_000e6
        );
        staking = new MasonryGenesisStaking(pass, fee, new MockGenesisSettlement(level, vault), usdc, 7000e18);
        fee.setGenesis(address(staking));
        level.mint(address(this), 7000e18);
        level.approve(address(staking), 7000e18);
        staking.fund();
        _buy(BASIC, MasonryGenesisPass.Tier.Genesis, 50e6);
        _buy(PRO, MasonryGenesisPass.Tier.Pro, 100e6);
        _buy(ULTRA, MasonryGenesisPass.Tier.Ultra, 500e6);
    }

    function testMembershipPricesAndSoulboundAccess() public {
        assertEq(usdc.balanceOf(TREASURY), 650e6);
        assertEq(pass.ownerOf(1), BASIC);
        assertEq(pass.ownerOf(2), PRO);
        assertEq(pass.ownerOf(3), ULTRA);
        vm.prank(BASIC);
        vm.expectRevert(MasonryGenesisPass.Soulbound.selector);
        pass.transferFrom(BASIC, KEEPER, 1);

        vm.warp(schedule.start());
        vm.startPrank(KEEPER);
        vm.expectRevert(MasonryGenesisStaking.NotEligible.selector);
        staking.deposit(0, 1e6);
        vm.expectRevert(MasonryGenesisStaking.NotEligible.selector);
        staking.claim(0);
        vm.stopPrank();
    }

    function testGenesisAndLpBoundariesPreserveWithdrawalsAndClaims() public {
        vm.warp(schedule.start() - 1 days - 1);
        _expectClosed(ULTRA, 0);
        vm.warp(schedule.start() - 1 days);
        vm.prank(ULTRA);
        staking.deposit(0, 100e6);
        vm.warp(schedule.start() - 1);
        _expectClosed(PRO, 0);
        vm.warp(schedule.start());
        vm.prank(PRO);
        staking.deposit(0, 100e6);

        vm.warp(schedule.lpOpens() - 1);
        _expectClosed(ULTRA, 1);
        vm.warp(schedule.lpOpens());
        vm.prank(PRO);
        staking.deposit(1, 100e18);
        vm.warp(schedule.end() - 1);
        vm.prank(ULTRA);
        staking.deposit(1, 100e18);
        assertEq(fee.totalFeeSharesCollected(), 1e18);

        vm.warp(schedule.end());
        _expectClosed(PRO, 1);
        _expectClosed(ULTRA, 0);
        vm.startPrank(PRO);
        staking.withdraw(1, 99.5e18);
        staking.claim(1);
        assertGt(level.balanceOf(PRO), 4000e18);
        vm.stopPrank();
    }

    function testKeeperCompoundUsesRemainingRewardsAndOneLpFee() public {
        vm.warp(schedule.start());
        vm.prank(BASIC);
        vm.expectRevert(MasonryGenesisStaking.NotEligible.selector);
        staking.setKeeper(KEEPER, 1);
        vm.startPrank(PRO);
        staking.deposit(0, 100e6);
        staking.setKeeper(KEEPER, 900e18);
        vm.stopPrank();

        vm.warp(schedule.lpOpens() - 1);
        vm.prank(KEEPER);
        vm.expectRevert(MasonryGenesisStaking.PoolClosed.selector);
        staking.compoundToLP(0, PRO, 1);
        vm.warp(schedule.lpOpens());
        vm.expectRevert(MasonryGenesisStaking.NotEligible.selector);
        staking.compoundToLP(0, PRO, 1);
        vm.prank(KEEPER);
        staking.compoundToLP(0, PRO, 1);

        (uint256 shares,,) = staking.positions(1, PRO);
        assertEq(shares, 995e18);
        assertEq(fee.totalFeeSharesCollected(), 5e18);
        vm.prank(KEEPER);
        vm.expectRevert(MasonryGenesisStaking.Cooldown.selector);
        staking.compoundToLP(0, PRO, 1);

        vm.prank(PRO);
        staking.setKeeper(KEEPER, 1);
        vm.warp(schedule.lpOpens() + 3 hours);
        vm.prank(KEEPER);
        staking.compoundToLP(0, PRO, 1);
        assertEq(fee.totalFeeSharesCollected(), 5.15625e18);
    }

    function testUltraAndGenesisEarnEqualRewardsOnEqualStake() public {
        vm.warp(schedule.start());
        vm.prank(BASIC);
        staking.deposit(0, 100e6);
        vm.prank(ULTRA);
        staking.deposit(0, 100e6);
        vm.warp(schedule.lpOpens());
        vm.prank(BASIC);
        staking.claim(0);
        vm.prank(ULTRA);
        staking.claim(0);
        assertEq(level.balanceOf(BASIC), 500e18);
        assertEq(level.balanceOf(ULTRA), 500e18);
    }

    function _expectClosed(
        address user,
        uint256 pool
    ) private {
        vm.prank(user);
        vm.expectRevert(MasonryGenesisStaking.PoolClosed.selector);
        staking.deposit(pool, 1);
    }

    function _buy(
        address user,
        MasonryGenesisPass.Tier tier,
        uint256 cost
    ) private {
        usdc.mint(user, cost + 1000e6);
        vault.mintShares(user, 1000e18);
        vm.startPrank(user);
        usdc.approve(address(pass), cost);
        pass.purchase(tier);
        usdc.approve(address(staking), type(uint256).max);
        vault.approve(address(staking), type(uint256).max);
        vm.stopPrank();
    }
}
