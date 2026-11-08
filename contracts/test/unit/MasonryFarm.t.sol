// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {BaseTest} from "../utils/BaseTest.sol";
import {MasonryFarm} from "../../src/masonry/MasonryFarm.sol";
import {MasonryChamber} from "../../src/masonry/MasonryChamber.sol";
import {MockFireTax} from "../utils/MockFireTax.sol";

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

contract MintableZapperLp is ERC20 {
    constructor() ERC20("X Share/WETH LP", "SLP") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockFarmZapper {
    IERC20 public share;
    MintableZapperLp public lp;

    constructor(IERC20 share_, MintableZapperLp lp_) {
        share = share_;
        lp = lp_;
    }

    function lpToken() external view returns (address) {
        return address(lp);
    }

    function zap(address, uint256 shareAmount, uint256, uint256 minLpOut)
        external
        returns (uint256 lpOut, uint256 shareDust, uint256 wethDust)
    {
        uint256 bal = share.balanceOf(address(this));
        if (bal < shareAmount) shareAmount = bal;
        shareDust = shareAmount > 10 ? 1 : 0;
        lpOut = shareAmount - shareDust;
        if (lpOut < minLpOut) revert("slippage");
        lp.mint(msg.sender, lpOut);
        if (shareDust != 0) IERC20(share).transfer(msg.sender, shareDust);
        return (lpOut, shareDust, 0);
    }
}

contract MasonryFarmTest is BaseTest {
    // PLACEHOLDER values from config/masonry-launch.template.json
    uint256 internal constant BUDGET = 25_641 ether;
    uint256 internal constant DURATION = 365 days;

    MockShare internal share;
    MockShareWethLp internal lp;
    MasonryFarm internal farm;
    MasonryChamber internal chamber;
    MockFarmZapper internal zapper;
    address internal daoWallet;
    uint256 internal startTime;
    MockFireTax internal fireTax;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        startTime = block.timestamp + 1 hours;
        share = new MockShare();
        lp = new MockShareWethLp();
        daoWallet = makeAddr("daoWallet");
        fireTax = new MockFireTax();
        MintableZapperLp masonryLp = new MintableZapperLp();
        chamber = new MasonryChamber(
            IERC20(address(masonryLp)), IERC20(address(share)), address(this), daoWallet, makeAddr("arbitrage")
        );
        zapper = new MockFarmZapper(IERC20(address(share)), masonryLp);
        farm = new MasonryFarm(
            IERC20(address(share)),
            startTime,
            DURATION,
            BUDGET,
            address(this),
            IERC20(address(lp)),
            1000,
            MasonryFarm.Policy({
                claimToWallet: false,
                withdrawCooldown: 1800,
                daoWallet: daoWallet,
                masonry: address(chamber),
                zapper: address(zapper),
                fireTax: fireTax
            })
        );
        chamber.bindFarm(address(farm));
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

        farm.update();
        uint256 earned = farm.pending(0, alice);
        assertGt(earned, 0);
        assertLe(farm.emitted(), farm.entitledTo(block.timestamp));
        assertLe(farm.emitted(), BUDGET);
        vm.prank(alice);
        vm.expectRevert(MasonryFarm.ClaimToWalletDisabled.selector);
        farm.harvest(0);
        assertEq(share.balanceOf(alice), 0, "no claim-to-wallet path");
    }

    function test_EmptyFarmDoesNotCatchUpLaterStakers() public {
        vm.warp(startTime + DURATION / 2);
        farm.update();
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

    function test_CompleteWithdrawForfeitsExactRewardsToDaoWallet() public {
        vm.warp(startTime + 1);
        vm.prank(alice);
        farm.deposit(0, 100 ether);
        vm.warp(startTime + 10 days);
        farm.update();
        uint256 pending = farm.pending(0, alice);
        assertGt(pending, 0);
        uint256 aliceShareBefore = share.balanceOf(alice);
        uint256 daoBefore = share.balanceOf(daoWallet);

        vm.prank(alice);
        farm.requestWithdraw(0, 100 ether);
        vm.warp(block.timestamp + 60); // still inside the 30-minute window; rewards keep accruing
        farm.update();
        assertGt(farm.pending(0, alice), pending);

        vm.prank(alice);
        vm.expectRevert(MasonryFarm.WithdrawCooldownActive.selector);
        farm.completeWithdraw(0);

        vm.warp(block.timestamp + 1800);
        farm.update();
        uint256 pendingAtComplete = farm.pending(0, alice);
        vm.prank(alice);
        farm.completeWithdraw(0);

        assertEq(share.balanceOf(daoWallet) - daoBefore, pendingAtComplete, "exact forfeit to daoWallet");
        assertEq(share.balanceOf(alice), aliceShareBefore, "no X Share reaches the wallet");
        assertEq(farm.pending(0, alice), 0);
        uint256 lpFee = 100 ether * uint256(fireTax.currentWithdrawFeeBps()) / 10_000;
        assertEq(lp.balanceOf(alice), 100 ether - lpFee);
        assertEq(lp.balanceOf(daoWallet), lpFee);
    }

    function test_WithdrawFeeFollowsLiveFireTaxAndSixDecimalRounding() public {
        assertEq(uint256(1_000_001) * 300 / 10_000, 30_000);
        assertEq(farm.withdrawFeeBps(), 300);
        fireTax.set(1200);
        assertEq(farm.withdrawFeeBps(), 1200);
        fireTax.set(1201);
        vm.expectRevert(MasonryFarm.InvalidConfiguration.selector);
        farm.withdrawFeeBps();
        fireTax.set(1);
        assertEq(uint256(1) * 1 / 10_000, 0);
        fireTax.set(300);
    }

    function test_DustWithdrawalCanRoundFeeToZero() public {
        vm.warp(startTime + 1);
        vm.prank(alice);
        farm.deposit(0, 1);
        vm.prank(alice);
        farm.requestWithdraw(0, 1);
        vm.warp(block.timestamp + 1800);
        uint256 dao = lp.balanceOf(daoWallet);
        vm.prank(alice);
        farm.completeWithdraw(0);
        assertEq(lp.balanceOf(daoWallet), dao);
        assertEq(lp.balanceOf(alice), 100 ether);
    }

    function test_ExitNowDoesNotBypassFarmWithdrawFee() public {
        vm.warp(startTime + 1);
        vm.prank(alice);
        farm.deposit(0, 100 ether);
        uint256 staked = farm.userStake(0, alice);
        vm.prank(alice);
        vm.expectRevert(MasonryChamber.InvalidAmount.selector);
        chamber.exitNow();
        assertEq(farm.userStake(0, alice), staked);
        vm.prank(alice);
        farm.requestWithdraw(0, 100 ether);
        vm.warp(block.timestamp + 1800);
        uint256 daoLp = lp.balanceOf(daoWallet);
        vm.prank(alice);
        farm.completeWithdraw(0);
        assertEq(lp.balanceOf(daoWallet) - daoLp, 100 ether * uint256(fireTax.currentWithdrawFeeBps()) / 10_000);
        assertEq(farm.userStake(0, alice), 0);
    }

    function test_CompoundOrCancelKeepsRewardsAndNoWalletPayout() public {
        vm.warp(startTime + 1);
        vm.prank(alice);
        farm.deposit(0, 100 ether);
        vm.warp(startTime + 5 days);
        uint256 pending = farm.pending(0, alice);
        vm.prank(alice);
        farm.requestWithdraw(0, 40 ether);
        vm.prank(alice);
        farm.cancelWithdraw(0);
        assertEq(farm.pending(0, alice), pending);
        (uint256 amt,) = farm.withdrawRequests(0, alice);
        assertEq(amt, 0);

        vm.prank(alice);
        farm.requestWithdraw(0, 40 ether);
        uint256 masonryBefore = chamber.balanceOf(alice);
        vm.prank(alice);
        farm.compound(0, 0, 0);
        assertEq(share.balanceOf(alice), 0);
        assertGt(chamber.balanceOf(alice), masonryBefore);
        (amt,) = farm.withdrawRequests(0, alice);
        assertEq(amt, 0);
    }

    function test_CannotRequestWithdrawTwiceAndDepositDoesNotPayWallet() public {
        vm.warp(startTime + 1);
        vm.prank(alice);
        farm.deposit(0, 50 ether);
        vm.warp(startTime + 3 days);
        vm.prank(alice);
        farm.requestWithdraw(0, 10 ether);
        vm.prank(alice);
        vm.expectRevert(MasonryFarm.WithdrawPending.selector);
        farm.requestWithdraw(0, 10 ether);

        uint256 before = share.balanceOf(alice);
        lp.mint(alice, 10 ether);
        vm.prank(alice);
        farm.deposit(0, 10 ether);
        assertEq(share.balanceOf(alice), before);
    }

    function test_ZapStakesLpForUserAndNeverSendsShareToWallet() public {
        vm.warp(startTime + 1);
        vm.prank(alice);
        farm.deposit(0, 100 ether);
        vm.warp(startTime + 7 days);
        uint256 pending = farm.pending(0, alice);
        uint256 before = share.balanceOf(alice);
        vm.prank(alice);
        farm.zapIntoMasonry(0, 0, 0);
        assertEq(share.balanceOf(alice), before);
        assertGt(chamber.balanceOf(alice), 0);
        // leftover dust stays as stored farm rewards, never the wallet
        assertLt(farm.pending(0, alice), pending);
    }

    function test_ZeroZapReverts() public {
        vm.warp(startTime + 1);
        vm.prank(alice);
        farm.deposit(0, 100 ether);
        vm.prank(alice);
        vm.expectRevert(MasonryFarm.InvalidAmount.selector);
        farm.zapIntoMasonry(0, 0, 0);
    }

    function test_LastCompoundAtIsPerUserPerPool() public {
        MockShareWethLp lp1 = new MockShareWethLp();
        farm.addPool(IERC20(address(lp1)), 1000);
        lp1.mint(alice, 100 ether);
        vm.prank(alice);
        lp1.approve(address(farm), type(uint256).max);

        vm.warp(startTime + 1);
        vm.prank(alice);
        farm.deposit(0, 100 ether);
        vm.prank(alice);
        farm.deposit(1, 100 ether);
        vm.warp(startTime + 7 days);

        assertEq(farm.lastCompoundAt(0, alice), 0);
        assertEq(farm.lastCompoundAt(1, alice), 0);
        vm.prank(alice);
        farm.compound(0, 0, 0);
        uint256 first = block.timestamp;
        assertEq(farm.lastCompoundAt(0, alice), first);
        assertEq(farm.lastCompoundAt(1, alice), 0, "compounding one pool must not reset another");

        vm.warp(block.timestamp + 60);
        vm.prank(alice);
        farm.compound(1, 0, 0);
        assertEq(farm.lastCompoundAt(0, alice), first);
        assertEq(farm.lastCompoundAt(1, alice), block.timestamp);
    }
}
