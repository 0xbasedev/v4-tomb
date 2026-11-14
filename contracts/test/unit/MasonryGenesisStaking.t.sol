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
import {MockMasonryLevel, MockMasonryUSDC, MockMasonryRedeemableVault} from "./MasonryGenesisLPBurnFee.t.sol";

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
        bool,
        CompoundPlan calldata
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
        _setupGenesis(block.timestamp + 2 days);
        _buy(BASIC, MasonryGenesisPass.Tier.Genesis, 50e6);
        _buy(PRO, MasonryGenesisPass.Tier.Pro, 100e6);
        _buy(ULTRA, MasonryGenesisPass.Tier.Ultra, 500e6);
    }

    function _setupGenesis(
        uint256 start
    ) private {
        schedule = new MasonryGenesisSchedule(start, address(this));
        pass = new MasonryGenesisPass(usdc, TREASURY, schedule);
        address c0 = address(level) < address(usdc) ? address(level) : address(usdc);
        address c1 = address(level) < address(usdc) ? address(usdc) : address(level);
        PoolKey memory key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), 3000, 60, IHooks(address(0)));
        vault.setPoolKey(key);
        fee = new MasonryGenesisLPBurnFee(
            IMasonryRedeemableLPVault(address(vault)),
            IMasonryBurnableLevel(address(level)),
            usdc,
            TREASURY,
            address(this),
            address(this)
        );
        staking = new MasonryGenesisStaking(pass, fee, new MockGenesisSettlement(level, vault), usdc, 7000e18);
        fee.setGenesis(address(staking));
        level.mint(address(this), 7000e18);
        level.approve(address(staking), 7000e18);
        staking.fund();
    }

    function testDeferredGenesisCanBeFundedAndScheduledExactlyOnce() public {
        _setupGenesis(0);
        assertTrue(staking.funded());
        assertFalse(schedule.active());
        assertFalse(schedule.lpOpen());
        assertEq(schedule.end(), 0);
        vm.prank(BASIC);
        vm.expectRevert(MasonryGenesisPass.InvalidPurchase.selector);
        pass.purchase(MasonryGenesisPass.Tier.Genesis);

        uint256 start = block.timestamp + 2 days;
        vm.prank(BASIC);
        vm.expectRevert(MasonryGenesisSchedule.Unauthorized.selector);
        schedule.schedule(start);
        vm.expectRevert(MasonryGenesisSchedule.InvalidStart.selector);
        schedule.schedule(block.timestamp);
        schedule.schedule(start);
        vm.expectRevert(MasonryGenesisSchedule.AlreadyScheduled.selector);
        schedule.schedule(start + 1 days);

        _buy(BASIC, MasonryGenesisPass.Tier.Genesis, 50e6);
        vm.warp(start - 1);
        assertFalse(schedule.active());
        vm.warp(start);
        assertTrue(schedule.active());
        vm.warp(start + 1 days - 1);
        assertFalse(schedule.lpOpen());
        vm.warp(start + 1 days);
        assertTrue(schedule.lpOpen());
        vm.warp(start + 7 days);
        assertFalse(schedule.active());
        assertFalse(schedule.lpOpen());
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
        staking.compoundToLP(0, PRO, 1, IMasonryGenesisSettlement.CompoundPlan(0, 0));
        vm.warp(schedule.lpOpens());
        vm.expectRevert(MasonryGenesisStaking.NotEligible.selector);
        staking.compoundToLP(0, PRO, 1, IMasonryGenesisSettlement.CompoundPlan(0, 0));
        vm.prank(KEEPER);
        staking.compoundToLP(0, PRO, 1, IMasonryGenesisSettlement.CompoundPlan(0, 0));

        (uint256 shares,,) = staking.positions(1, PRO);
        assertApproxEqAbs(shares, 995e18, 1e3); // Pro stakes 98 net of the 2% deposit fee; 1-wei acc rounding
        assertApproxEqAbs(fee.totalFeeSharesCollected(), 5e18, 10);
        vm.prank(KEEPER);
        vm.expectRevert(MasonryGenesisStaking.Cooldown.selector);
        staking.compoundToLP(0, PRO, 1, IMasonryGenesisSettlement.CompoundPlan(0, 0));

        // Three hours on, the shared cooldown has passed but a Pro keeper is on a
        // six-hour clock; the member can still compound by hand.
        vm.warp(schedule.lpOpens() + 3 hours);
        vm.prank(KEEPER);
        vm.expectRevert(MasonryGenesisStaking.Cooldown.selector);
        staking.compoundToLP(0, PRO, 1, IMasonryGenesisSettlement.CompoundPlan(0, 0));
        vm.prank(PRO);
        staking.compoundToLP(0, PRO, 1, IMasonryGenesisSettlement.CompoundPlan(0, 0));
        assertApproxEqAbs(fee.totalFeeSharesCollected(), 5.15625e18, 10);
    }

    function testKeeperCadenceIsSixHoursForProAndThreeForUltra() public {
        IMasonryGenesisSettlement.CompoundPlan memory plan = IMasonryGenesisSettlement.CompoundPlan(0, 0);
        _stakeWithKeeper(PRO);
        _stakeWithKeeper(ULTRA);
        uint256 t0 = schedule.lpOpens();
        vm.warp(t0);
        assertEq(staking.nextKeeperCompoundAt(0, PRO), 0);

        vm.startPrank(KEEPER);
        staking.compoundToLP(0, PRO, 1, plan);
        staking.compoundToLP(0, ULTRA, 1, plan);
        assertEq(staking.lastKeeperCompoundAt(0, PRO), t0);
        assertEq(staking.nextKeeperCompoundAt(0, PRO), t0 + 6 hours);
        assertEq(staking.nextKeeperCompoundAt(0, ULTRA), t0 + 3 hours);

        vm.warp(t0 + 3 hours - 1);
        vm.expectRevert(MasonryGenesisStaking.Cooldown.selector);
        staking.compoundToLP(0, ULTRA, 1, plan);

        vm.warp(t0 + 3 hours);
        staking.compoundToLP(0, ULTRA, 1, plan);
        vm.expectRevert(MasonryGenesisStaking.Cooldown.selector);
        staking.compoundToLP(0, PRO, 1, plan);

        vm.warp(t0 + 6 hours - 1);
        vm.expectRevert(MasonryGenesisStaking.Cooldown.selector);
        staking.compoundToLP(0, PRO, 1, plan);

        vm.warp(t0 + 6 hours);
        staking.compoundToLP(0, PRO, 1, plan);
        staking.compoundToLP(0, ULTRA, 1, plan);
        vm.stopPrank();
        assertEq(staking.nextKeeperCompoundAt(0, PRO), t0 + 12 hours);
    }

    function testManualActionNeverShortensOrSkipsTheKeeperClock() public {
        IMasonryGenesisSettlement.CompoundPlan memory plan = IMasonryGenesisSettlement.CompoundPlan(0, 0);
        _stakeWithKeeper(PRO);
        uint256 t0 = schedule.lpOpens();
        vm.warp(t0);
        vm.prank(KEEPER);
        staking.compoundToLP(0, PRO, 1, plan);

        // A manual claim at +5h restarts the shared 3h cooldown, so the keeper
        // waits for both clocks: +8h, not +6h.
        vm.warp(t0 + 5 hours);
        vm.prank(PRO);
        staking.claim(0);
        assertEq(staking.nextKeeperCompoundAt(0, PRO), t0 + 8 hours);
        vm.warp(t0 + 6 hours);
        vm.prank(KEEPER);
        vm.expectRevert(MasonryGenesisStaking.Cooldown.selector);
        staking.compoundToLP(0, PRO, 1, plan);
        vm.warp(t0 + 8 hours);
        vm.prank(KEEPER);
        staking.compoundToLP(0, PRO, 1, plan);
        // The keeper interval is tracked per source pool.
        assertEq(staking.lastKeeperCompoundAt(1, PRO), 0);
    }

    function testUpgradeToUltraMovesKeeperToThreeHourClock() public {
        IMasonryGenesisSettlement.CompoundPlan memory plan = IMasonryGenesisSettlement.CompoundPlan(0, 0);
        _stakeWithKeeper(PRO);
        uint256 t0 = schedule.lpOpens();
        vm.warp(t0);
        vm.prank(KEEPER);
        staking.compoundToLP(0, PRO, 1, plan);

        usdc.mint(PRO, 400e6);
        vm.startPrank(PRO);
        usdc.approve(address(pass), 400e6);
        pass.upgrade(MasonryGenesisPass.Tier.Ultra);
        vm.stopPrank();
        assertEq(staking.nextKeeperCompoundAt(0, PRO), t0 + 3 hours);

        vm.warp(t0 + 3 hours);
        vm.prank(KEEPER);
        staking.compoundToLP(0, PRO, 1, plan);
    }

    function testKeeperIntervalTable() public view {
        assertEq(staking.PRO_KEEPER_INTERVAL(), 6 hours);
        assertEq(staking.ULTRA_KEEPER_INTERVAL(), 3 hours);
        assertEq(staking.COMPOUND_COOLDOWN(), 3 hours);
        assertEq(staking.keeperInterval(MasonryGenesisPass.Tier.None), 0);
        assertEq(staking.keeperInterval(MasonryGenesisPass.Tier.Genesis), 0);
        assertEq(staking.keeperInterval(MasonryGenesisPass.Tier.Pro), 6 hours);
        assertEq(staking.keeperInterval(MasonryGenesisPass.Tier.Ultra), 3 hours);
        // No keeper tier: there is never a keeper run to wait for.
        assertEq(staking.nextKeeperCompoundAt(0, BASIC), type(uint256).max);
    }

    function _stakeWithKeeper(
        address user
    ) private {
        vm.warp(schedule.start());
        vm.startPrank(user);
        staking.deposit(0, 100e6);
        staking.setKeeper(KEEPER, 1);
        vm.stopPrank();
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
        // Same deposit, different fee: rewards follow NET shares (3% vs 0%), not gross deposits.
        (uint256 basicNet,,) = staking.positions(0, BASIC);
        (uint256 ultraNet,,) = staking.positions(0, ULTRA);
        assertEq(basicNet, 97e6);
        assertEq(ultraNet, 100e6);
        assertApproxEqAbs(level.balanceOf(BASIC) * ultraNet, level.balanceOf(ULTRA) * basicNet, 1e18);
        assertApproxEqAbs(level.balanceOf(BASIC) + level.balanceOf(ULTRA), 1000e18, 10);
    }

    function testPoolZeroDepositFeeByTierGoesToTreasuryInUsdc() public {
        vm.warp(schedule.start());
        uint256 t0 = usdc.balanceOf(TREASURY);
        uint256 collected;
        address[3] memory users = [BASIC, PRO, ULTRA];
        uint256[3] memory net = [uint256(97e6), 98e6, 100e6];
        for (uint256 i; i < 3; ++i) {
            uint256 before = usdc.balanceOf(users[i]);
            vm.prank(users[i]);
            staking.deposit(0, 100e6);
            (uint256 shares,,) = staking.positions(0, users[i]);
            assertEq(shares, net[i], "net shares");
            assertEq(before - usdc.balanceOf(users[i]), 100e6, "user pays gross");
            collected += 100e6 - net[i];
            assertEq(usdc.balanceOf(TREASURY) - t0, collected, "treasury receives each fee in USDC");
        }
        (uint256 total,,) = staking.pools(0);
        assertEq(total, 295e6, "only net shares earn");
        assertEq(usdc.balanceOf(address(staking)), 295e6, "staking holds net only");
    }

    function testDepositFeeEmitsAndUltraPaysNone() public {
        vm.warp(schedule.start());
        vm.expectEmit(true, false, false, true);
        emit MasonryGenesisStaking.DepositFeePaid(BASIC, MasonryGenesisPass.Tier.Genesis, 3e6);
        vm.prank(BASIC);
        staking.deposit(0, 100e6);
        uint256 t0 = usdc.balanceOf(TREASURY);
        vm.prank(ULTRA);
        staking.deposit(0, 100e6);
        assertEq(usdc.balanceOf(TREASURY), t0, "Ultra pays 0%");
    }

    function testDepositFeeBpsTable() public view {
        assertEq(staking.depositFeeBps(MasonryGenesisPass.Tier.Genesis), 300);
        assertEq(staking.depositFeeBps(MasonryGenesisPass.Tier.Pro), 200);
        assertEq(staking.depositFeeBps(MasonryGenesisPass.Tier.Ultra), 0);
    }

    function testWithdrawReturnsNetSharesOnly() public {
        vm.warp(schedule.start());
        vm.startPrank(BASIC);
        staking.deposit(0, 100e6);
        uint256 before = usdc.balanceOf(BASIC);
        staking.withdraw(0, 97e6);
        assertEq(usdc.balanceOf(BASIC) - before, 97e6);
        vm.expectRevert();
        staking.withdraw(0, 1);
        vm.stopPrank();
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
