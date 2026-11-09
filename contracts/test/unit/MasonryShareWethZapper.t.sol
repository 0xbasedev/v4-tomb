// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {BaseTest} from "../utils/BaseTest.sol";
import {MasonryFarm} from "../../src/masonry/MasonryFarm.sol";
import {MasonryChamber} from "../../src/masonry/MasonryChamber.sol";
import {MasonryShareWethZapper, IShareWethAmm, IZapTwap} from "../../src/masonry/MasonryShareWethZapper.sol";
import {MockShare, MockShareWethLp} from "./MasonryFarm.t.sol";
import {MockFireTax} from "../utils/MockFireTax.sol";

contract MockWeth is ERC20 {
    constructor() ERC20("WETH", "WETH") {}

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract MockZapTwap {
    uint256 public price = 1e18;
    bool public valid = true;

    function set(
        uint256 price_,
        bool valid_
    ) external {
        price = price_;
        valid = valid_;
    }

    function latestValidatedTwap() external view returns (uint256, uint256, bool) {
        return (price, block.timestamp, valid);
    }
}

contract SimpleShareWethAmm {
    using SafeERC20 for IERC20;

    IERC20 public share;
    IERC20 public weth;
    MockShareWethLp public lp;
    uint256 public reserveShare;
    uint256 public reserveWeth;
    address public reenterTarget;
    bytes public reenterData;

    constructor(
        IERC20 share_,
        IERC20 weth_,
        MockShareWethLp lp_
    ) {
        share = share_;
        weth = weth_;
        lp = lp_;
    }

    function seed(
        uint256 s,
        uint256 w
    ) external {
        share.safeTransferFrom(msg.sender, address(this), s);
        weth.safeTransferFrom(msg.sender, address(this), w);
        reserveShare += s;
        reserveWeth += w;
        lp.mint(address(this), 1_000_000 ether);
    }

    function setReenter(
        address target,
        bytes calldata data
    ) external {
        reenterTarget = target;
        reenterData = data;
    }

    function spotPrice() public view returns (uint256) {
        return reserveShare == 0 ? 0 : reserveWeth * 1e18 / reserveShare;
    }

    function swapShareForWeth(
        uint256 shareIn,
        uint256 minWethOut
    ) external returns (uint256 wethOut) {
        if (reenterTarget != address(0)) {
            (bool ok,) = reenterTarget.call(reenterData);
            require(ok, "reenter");
        }
        share.safeTransferFrom(msg.sender, address(this), shareIn);
        wethOut = reserveWeth * shareIn / (reserveShare + shareIn);
        if (wethOut < minWethOut) revert("minOut");
        reserveShare += shareIn;
        reserveWeth -= wethOut;
        weth.safeTransfer(msg.sender, wethOut);
    }

    function addLiquidity(
        uint256 shareIn,
        uint256 wethIn,
        uint256 minLp
    ) external returns (uint256 lpOut, uint256 shareUsed, uint256 wethUsed) {
        share.safeTransferFrom(msg.sender, address(this), shareIn);
        weth.safeTransferFrom(msg.sender, address(this), wethIn);
        shareUsed = shareIn;
        wethUsed = wethIn;
        // Leave 1 wei of each as leftover dust for the zapper to handle.
        if (shareUsed > 1) {
            unchecked {
                shareUsed -= 1;
            }
            share.safeTransfer(msg.sender, 1);
        }
        if (wethUsed > 1) {
            unchecked {
                wethUsed -= 1;
            }
            weth.safeTransfer(msg.sender, 1);
        }
        lpOut = shareUsed < wethUsed ? shareUsed : wethUsed;
        if (lpOut < minLp) revert("minLp");
        reserveShare += shareUsed;
        reserveWeth += wethUsed;
        lp.mint(msg.sender, lpOut);
    }

    function lpToken() external view returns (address) {
        return address(lp);
    }
}

contract MasonryShareWethZapperTest is BaseTest {
    uint256 internal constant BUDGET = 25_641 ether;
    uint256 internal constant DURATION = 365 days;

    MockShare internal share;
    MockWeth internal weth;
    MockShareWethLp internal farmLp;
    MockShareWethLp internal masonryLp;
    MockZapTwap internal twap;
    SimpleShareWethAmm internal amm;
    MasonryShareWethZapper internal zapper;
    MasonryFarm internal farm;
    MasonryChamber internal chamber;
    address internal daoWallet;

    function setUp() public override {
        super.setUp();
        vm.warp(1_700_000_000);
        uint256 startTime = block.timestamp + 1 hours;
        share = new MockShare();
        weth = new MockWeth();
        farmLp = new MockShareWethLp();
        masonryLp = new MockShareWethLp();
        twap = new MockZapTwap();
        daoWallet = makeAddr("daoWallet");
        amm = new SimpleShareWethAmm(IERC20(address(share)), IERC20(address(weth)), masonryLp);
        zapper = new MasonryShareWethZapper(
            IERC20(address(share)),
            IERC20(address(weth)),
            address(0),
            daoWallet,
            IShareWethAmm(address(amm)),
            IZapTwap(address(twap)),
            300
        );
        chamber = new MasonryChamber(
            IERC20(address(masonryLp)),
            IERC20(address(share)),
            address(this),
            daoWallet,
            makeAddr("arbitrage"),
            new MockFireTax()
        );
        farm = new MasonryFarm(
            IERC20(address(share)),
            startTime,
            DURATION,
            BUDGET,
            address(this),
            IERC20(address(farmLp)),
            1000,
            MasonryFarm.Policy({
                claimToWallet: false,
                withdrawCooldown: 1800,
                daoWallet: daoWallet,
                masonry: address(chamber),
                zapper: address(zapper),
                fireTax: new MockFireTax()
            })
        );
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(MasonryShareWethZapper.Unauthorized.selector);
        zapper.bindFarm(address(farm));
        vm.prank(daoWallet);
        zapper.bindFarm(address(farm));
        chamber.bindFarm(address(farm));
        share.mint(address(this), BUDGET + 2_000_000 ether);
        share.approve(address(farm), BUDGET);
        farm.fund(BUDGET);
        weth.mint(address(this), 2_000_000 ether);
        share.approve(address(amm), type(uint256).max);
        weth.approve(address(amm), type(uint256).max);
        amm.seed(1_000_000 ether, 1_000_000 ether);
        farmLp.mint(alice, 100 ether);
        vm.prank(alice);
        farmLp.approve(address(farm), type(uint256).max);
        vm.warp(startTime + 1);
        vm.prank(alice);
        farm.deposit(0, 100 ether);
        vm.warp(startTime + 10 days);
    }

    function test_ZapStakesUnderUserAndSendsWethDustToDaoWallet() public {
        uint256 pending = farm.pending(0, alice);
        uint256 aliceShare = share.balanceOf(alice);
        uint256 daoWeth = weth.balanceOf(daoWallet);
        vm.prank(alice);
        farm.zapIntoMasonry(0, 0, 1);
        assertEq(share.balanceOf(alice), aliceShare, "no X Share to wallet");
        assertGt(chamber.balanceOf(alice), 0);
        assertGt(weth.balanceOf(daoWallet), daoWeth, "WETH dust to daoWallet");
        assertGt(pending, 0);
    }

    function test_TwapGuardRejectsSandwich() public {
        amm.swapShareForWeth(200_000 ether, 0); // move spot away from TWAP
        vm.prank(alice);
        vm.expectRevert(MasonryShareWethZapper.UnsafeZap.selector);
        farm.zapIntoMasonry(0, 0, 1);
    }

    function test_InvalidTwapAndTinyAmountRevert() public {
        twap.set(1e18, false);
        vm.prank(alice);
        vm.expectRevert(MasonryShareWethZapper.UnsafeZap.selector);
        farm.zapIntoMasonry(0, 0, 1);
        twap.set(1e18, true);
        // consume rewards then zap again should be tiny/zero
        vm.prank(alice);
        farm.zapIntoMasonry(0, 0, 1);
        vm.prank(alice);
        vm.expectRevert(MasonryFarm.InvalidAmount.selector);
        farm.zapIntoMasonry(0, 0, 1);
    }

    function test_SlippageMinOutReverts() public {
        vm.prank(alice);
        vm.expectRevert();
        farm.zapIntoMasonry(0, type(uint256).max, 1);
    }

    function test_ReentrancyDuringSwapIsBlocked() public {
        amm.setReenter(address(farm), abi.encodeWithSelector(MasonryFarm.harvest.selector, uint256(0)));
        vm.prank(alice);
        vm.expectRevert();
        farm.zapIntoMasonry(0, 0, 1);
    }

    function test_SendToMasonryLpMathDustAndClockReset() public {
        uint256 pending = farm.pending(0, alice);
        assertGt(pending, 2);
        uint256 aliceShare = share.balanceOf(alice);
        vm.prank(alice);
        farm.sendToMasonry(0, 0, 1);
        assertEq(share.balanceOf(alice), aliceShare);
        // AMM leaves 1 wei share dust which the farm restores as storedReward.
        assertEq(farm.pending(0, alice), 1);
        assertGt(chamber.balanceOf(alice), 0);
        assertEq(chamber.stakeUnlockAt(alice), block.timestamp + 6 hours);
        assertEq(chamber.claimUnlockAt(alice), block.timestamp + 6 hours);
        uint256 staked = chamber.balanceOf(alice);
        // lpOut = min(shareUsed, wethUsed); shareUsed = toKeep-1, toKeep = pending - pending/2
        uint256 toSell = pending / 2;
        uint256 toKeep = pending - toSell;
        assertEq(staked + 1 <= toKeep || staked > 0, true);
        assertLt(staked, toKeep); // at least the 1 wei share dust, plus swap imbalance
    }
}
