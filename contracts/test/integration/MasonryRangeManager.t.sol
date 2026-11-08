// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MasonryRangeManager, IMasonryRangeTwap} from "../../src/masonry/MasonryRangeManager.sol";
import {MasonryRangeLib} from "../../src/masonry/MasonryRangeLib.sol";
import {MasonryLevelPrice} from "../../src/masonry/MasonryLevelPrice.sol";

contract MockAsset is ERC20 {
    constructor(
        string memory name_
    ) ERC20(name_, name_) {}

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract MockQuote is ERC20 {
    constructor() ERC20("USDG", "USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract MockRangeTwap is IMasonryRangeTwap {
    uint256 public price = 1e18;
    bool public valid = true;

    function latestValidatedTwap() external view returns (uint256, uint256, bool) {
        return (price, block.timestamp, valid);
    }

    function set(
        uint256 price_,
        bool valid_
    ) external {
        price = price_;
        valid = valid_;
    }
}

contract MasonryRangeManagerTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    PoolManager private manager;
    PoolSwapTest private swaps;
    PoolModifyLiquidityTest private liqRouter;
    MockQuote private usdg;

    function setUp() public {
        manager = new PoolManager(address(this));
        swaps = new PoolSwapTest(manager);
        liqRouter = new PoolModifyLiquidityTest(manager);
        usdg = new MockQuote();
    }

    function testConstructorRejectsInvalidConfig() public {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(1)),
            currency1: Currency.wrap(address(2)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        vm.expectRevert(MasonryRangeLib.InvalidRangeConfig.selector);
        new MasonryRangeManager(
            IPoolManager(address(manager)),
            key,
            IMasonryRangeTwap(address(1)),
            address(this),
            true,
            400,
            200,
            1800,
            300,
            1
        );
    }

    function testXTombPoolOutOfRangeRecenterInRangeNoopCooldownAndManipulation() public {
        _exercisePool("xTOMB");
    }

    function testXSharePoolOutOfRangeRecenterInRangeNoopCooldownAndManipulation() public {
        _exercisePool("xSHARE");
    }

    function testBothPoolsConserveValueAndRejectSandwich() public {
        _exercisePool("xTOMB");
        _exercisePool("xSHARE");
    }

    function testNudgeNeverRevertsAndCanRecenterWithStipend() public {
        Env memory e = _boot("xTOMB");
        e.rm.nudge();
        _sellToward(e, 1300);
        (uint160 sqrtAfter,,,) = IPoolManager(address(manager)).getSlot0(e.key.toId());
        e.twap.set(MasonryLevelPrice.fromSqrtPrice(sqrtAfter, e.asset0), true);
        assertTrue(e.rm.shouldRebalance());
        int24 oldLower = e.rm.tickLower();
        e.rm.nudge{gas: MasonryRangeLib.NUDGE_STIPEND}();
        assertTrue(e.rm.tickLower() != oldLower);
        assertGt(e.rm.liquidity(), 0);
        assertFalse(e.rm.shouldRebalance());
    }

    function testThinPoolAndUnauthorizedDeposit() public {
        Env memory e = _boot("xSHARE");
        vm.prank(address(0xBEEF));
        vm.expectRevert(MasonryRangeManager.Unauthorized.selector);
        e.rm.depositFromHook(1, 1, address(this));

        MasonryRangeManager thin = new MasonryRangeManager(
            manager, e.key, e.twap, address(this), e.asset0, 1500, 1000, 1800, 300, type(uint128).max
        );
        e.asset.approve(address(thin), type(uint256).max);
        usdg.approve(address(thin), type(uint256).max);
        vm.expectRevert(MasonryRangeManager.ThinPool.selector);
        thin.donate(100e18, 100e6);
    }

    struct Env {
        MockAsset asset;
        bool asset0;
        PoolKey key;
        MockRangeTwap twap;
        MasonryRangeManager rm;
    }

    function _exercisePool(
        string memory symbol
    ) private {
        Env memory e = _boot(symbol);
        _assertSeededNoop(e);
        _assertManipulationAndSandwich(e);
        _recenterAndConserve(e);
        _cooldownThenDeposit(e);
    }

    function _boot(
        string memory symbol
    ) private returns (Env memory e) {
        e.asset = new MockAsset(symbol);
        e.asset0 = address(e.asset) < address(usdg);
        e.key = PoolKey({
            currency0: Currency.wrap(e.asset0 ? address(e.asset) : address(usdg)),
            currency1: Currency.wrap(e.asset0 ? address(usdg) : address(e.asset)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        uint160 peg = uint160(e.asset0 ? (uint256(1) << 96) / 1e6 : (uint256(1) << 96) * 1e6);
        manager.initialize(e.key, peg);
        e.asset.mint(address(this), 5_000_000e18);
        usdg.mint(address(this), 5_000_000e6);
        e.asset.approve(address(liqRouter), type(uint256).max);
        usdg.approve(address(liqRouter), type(uint256).max);
        e.asset.approve(address(swaps), type(uint256).max);
        usdg.approve(address(swaps), type(uint256).max);
        int24 center = TickMath.getTickAtSqrtPrice(peg) / 60 * 60;
        liqRouter.modifyLiquidity(e.key, ModifyLiquidityParams(center - 6000, center + 6000, 1e16, 0), "");
        e.twap = new MockRangeTwap();
        e.rm = new MasonryRangeManager(manager, e.key, e.twap, address(this), e.asset0, 1500, 1000, 1800, 300, 1e12);
        e.asset.approve(address(e.rm), type(uint256).max);
        usdg.approve(address(e.rm), type(uint256).max);
        e.rm.donate(20_000e18, 20_000e6);
        assertTrue(e.rm.seeded());
        assertGt(e.rm.liquidity(), 0);
        assertLt(e.rm.tickLower(), TickMath.getTickAtSqrtPrice(peg));
        assertGt(e.rm.tickUpper(), TickMath.getTickAtSqrtPrice(peg));
    }

    function _assertSeededNoop(
        Env memory e
    ) private {
        assertFalse(e.rm.shouldRebalance());
        vm.expectRevert(MasonryRangeManager.NoRecenterNeeded.selector);
        e.rm.rebalance();
    }

    function _assertManipulationAndSandwich(
        Env memory e
    ) private {
        _sellToward(e, 1300);
        (uint160 sqrtAfter,,,) = IPoolManager(address(manager)).getSlot0(e.key.toId());
        assertLe(MasonryLevelPrice.fromSqrtPrice(sqrtAfter, e.asset0), 0.9e18);
        uint128 guardedLiq = e.rm.liquidity();
        int24 guardedLower = e.rm.tickLower();
        int24 guardedUpper = e.rm.tickUpper();
        vm.expectRevert(MasonryRangeManager.UnsafeRebalance.selector);
        e.rm.rebalance();
        _buyToward(e, 1300);
        assertEq(e.rm.liquidity(), guardedLiq, "rejected rebalance must not move the position");
        assertEq(e.rm.tickLower(), guardedLower);
        assertEq(e.rm.tickUpper(), guardedUpper);
    }

    function _recenterAndConserve(
        Env memory e
    ) private {
        _sellToward(e, 1300);
        (uint160 sqrtAfter,,,) = IPoolManager(address(manager)).getSlot0(e.key.toId());
        e.twap.set(MasonryLevelPrice.fromSqrtPrice(sqrtAfter, e.asset0), true);
        assertTrue(e.rm.shouldRebalance());
        (uint256 before0, uint256 before1) = _inventory(e.rm, e.key);
        int24 oldLower = e.rm.tickLower();
        int24 oldUpper = e.rm.tickUpper();
        vm.recordLogs();
        e.rm.rebalance();
        _assertRebalanceAccounting(e);
        assertTrue(e.rm.tickLower() != oldLower || e.rm.tickUpper() != oldUpper);
        assertFalse(e.rm.shouldRebalance());
        (uint256 after0, uint256 after1) = _inventory(e.rm, e.key);
        uint256 beforeValue = MasonryRangeLib.valueInCurrency1(before0, before1, sqrtAfter);
        uint256 afterValue = MasonryRangeLib.valueInCurrency1(after0, after1, sqrtAfter);
        assertFalse(
            MasonryRangeLib.exceedsLoss(beforeValue, afterValue, MasonryRangeLib.MAX_INVENTORY_LOSS_BPS),
            "rebalance lost more than the inventory slippage bound"
        );
        assertGt(e.rm.liquidity(), 0, "recenter must redeploy liquidity into the new band");
        vm.expectRevert(MasonryRangeManager.SameBlockRebalance.selector);
        e.rm.rebalance();
    }

    function _cooldownThenDeposit(
        Env memory e
    ) private {
        vm.roll(block.number + 1);
        _sellToward(e, 1300);
        (uint160 sqrtAfter,,,) = IPoolManager(address(manager)).getSlot0(e.key.toId());
        e.twap.set(MasonryLevelPrice.fromSqrtPrice(sqrtAfter, e.asset0), true);
        if (e.rm.shouldRebalance()) {
            vm.expectRevert(MasonryRangeManager.CooldownActive.selector);
            e.rm.rebalance();
            vm.warp(block.timestamp + 1800);
            vm.roll(block.number + 1);
            e.rm.rebalance();
            assertFalse(e.rm.shouldRebalance());
        } else {
            vm.warp(block.timestamp + 1800);
            vm.roll(block.number + 1);
            vm.expectRevert(MasonryRangeManager.NoRecenterNeeded.selector);
            e.rm.rebalance();
        }
        (uint256 shares, uint256 assetIn, uint256 quoteIn) = e.rm.depositFromHook(1000e18, 1000e6, address(this));
        assertGt(shares, 0);
        assertTrue(assetIn > 0 || quoteIn > 0);
        e.rm.nudge();
    }


    function _assertRebalanceAccounting(
        Env memory e
    ) private {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 topic = keccak256(
            "RangeRebalanced(int24,int24,uint128,int24,uint256,uint256,uint256,uint256,int256,int256)"
        );
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(e.rm) || logs[i].topics[0] != topic) continue;
            (
                int24 reportedLower,
                int24 reportedUpper,
                uint128 reportedLiq,
                ,
                uint256 principal0,
                uint256 principal1,
                uint256 fees0,
                uint256 fees1,
                int256 swap0,
                int256 swap1
            ) = abi.decode(
                logs[i].data, (int24, int24, uint128, int24, uint256, uint256, uint256, uint256, int256, int256)
            );
            assertEq(reportedLower, e.rm.tickLower());
            assertEq(reportedUpper, e.rm.tickUpper());
            assertEq(reportedLiq, e.rm.liquidity());
            assertTrue(principal0 > 0 || principal1 > 0, "rebalance must report withdrawn principal");
            assertTrue(fees0 > 0 || fees1 > 0, "rebalance must report fees collected while the last band was active");
            // Inventory swap may be a no-op if the leftover mix already matches; the legs are still reported.
            swap0;
            swap1;
            found = true;
        }
        assertTrue(found, "RangeRebalanced accounting event missing");
    }

    function _asAssetValue(
        uint256 quote6,
        uint256 price18
    ) private pure returns (uint256) {
        return quote6 * 1e18 / 1e6 * 1e18 / price18;
    }

    function _sellToward(
        Env memory e,
        int24 tickDelta
    ) private {
        (, int24 tick,,) = IPoolManager(address(manager)).getSlot0(e.key.toId());
        int24 target = e.asset0 ? tick - tickDelta : tick + tickDelta;
        swaps.swap(
            e.key,
            SwapParams({
                zeroForOne: e.asset0,
                amountSpecified: -int256(1_000_000e18),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(target)
            }),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function _buyToward(
        Env memory e,
        int24 tickDelta
    ) private {
        (, int24 tick,,) = IPoolManager(address(manager)).getSlot0(e.key.toId());
        int24 target = e.asset0 ? tick + tickDelta : tick - tickDelta;
        swaps.swap(
            e.key,
            SwapParams({
                zeroForOne: !e.asset0,
                amountSpecified: -int256(1_000_000e6),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(target)
            }),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function _swapAsset(
        PoolKey memory key,
        bool asset0,
        int256 amountSpecified
    ) private {
        swaps.swap(
            key,
            SwapParams({
                zeroForOne: amountSpecified < 0 ? asset0 : !asset0,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: (amountSpecified < 0 ? asset0 : !asset0)
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }

    function _inventory(
        MasonryRangeManager rm,
        PoolKey memory key
    ) private view returns (uint256 amount0, uint256 amount1) {
        IERC20 token0 = IERC20(Currency.unwrap(key.currency0));
        IERC20 token1 = IERC20(Currency.unwrap(key.currency1));
        amount0 = token0.balanceOf(address(rm));
        amount1 = token1.balanceOf(address(rm));
        uint128 liq = rm.liquidity();
        if (liq == 0) return (amount0, amount1);
        (uint160 sqrtPrice,,,) = IPoolManager(address(manager)).getSlot0(key.toId());
        uint160 sa = TickMath.getSqrtPriceAtTick(rm.tickLower());
        uint160 sb = TickMath.getSqrtPriceAtTick(rm.tickUpper());
        if (sqrtPrice <= sa) {
            amount0 += SqrtPriceMath.getAmount0Delta(sa, sb, liq, false);
        } else if (sqrtPrice >= sb) {
            amount1 += SqrtPriceMath.getAmount1Delta(sa, sb, liq, false);
        } else {
            amount0 += SqrtPriceMath.getAmount0Delta(sqrtPrice, sb, liq, false);
            amount1 += SqrtPriceMath.getAmount1Delta(sa, sqrtPrice, liq, false);
        }
    }
}
