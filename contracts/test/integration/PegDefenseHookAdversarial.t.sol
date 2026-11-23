// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {HookPoolFixture} from "../utils/HookPoolFixture.t.sol";

import {Oracle} from "../../src/oracle/Oracle.sol";
import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";

import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

/**
 * @title PegDefenseHookAdversarialTest
 * @notice Swap-path tests against a real v4-core PoolManager. Covers what the hook
 *         enforces on the official pool (exact-in and exact-out sell tax, batched
 *         settlement, oracle integrity), and pins down what it deliberately does NOT
 *         enforce (hookless pools, router-level exemptions) so those limits stay explicit.
 *
 *         Runs twice — once per token ordering — via the two concrete contracts below.
 */
abstract contract PegDefenseHookAdversarialTest is HookPoolFixture {
    int256 internal constant DEEP_LIQUIDITY = 100_000 ether;

    /// @dev Money tick −5940 → price ≈ 0.552 WETH per MONEY: below 1.12, so the 12% tier.
    int24 internal constant DEPEGGED_TICK = -5940;
    uint256 internal constant DEPEGGED_RATE_BPS = 1200;

    // ------------------------------------------------------------------
    // Sell tax — exact input
    // ------------------------------------------------------------------

    function test_ExactInSell_TaxIsRateTimesGrossInput() public {
        _initWithFullRange(DEPEGGED_TICK, DEEP_LIQUIDITY);
        _enableTax();

        uint256 gross = 1000 ether;
        uint256 supplyBefore = money.totalSupply();
        uint256 aliceBefore = money.balanceOf(alice);

        _sellExactIn(alice, gross);

        uint256 burned = supplyBefore - money.totalSupply();
        assertEq(aliceBefore - money.balanceOf(alice), gross, "seller pays exactly the specified input");
        assertEq(burned, gross * DEPEGGED_RATE_BPS / 10_000, "tax = rate x gross input");
        assertEq(money.balanceOf(address(hook)), 0, "hook retains nothing");
    }

    // ------------------------------------------------------------------
    // Sell tax — exact output (unit-mixing regression)
    // ------------------------------------------------------------------

    function test_ExactOutSell_TaxIsChargedOnMoneyNotOnWethOutput() public {
        _initWithFullRange(DEPEGGED_TICK, DEEP_LIQUIDITY);
        _enableTax();

        uint256 wethOut = 10 ether;
        uint256 supplyBefore = money.totalSupply();
        uint256 aliceMoneyBefore = money.balanceOf(alice);
        uint256 aliceWethBefore = weth.balanceOf(alice);

        _sellExactOut(alice, wethOut);

        uint256 burned = supplyBefore - money.totalSupply();
        uint256 paid = aliceMoneyBefore - money.balanceOf(alice);
        uint256 poolTook = paid - burned;

        assertEq(weth.balanceOf(alice) - aliceWethBefore, wethOut, "seller receives exactly the specified output");
        // At ~0.55 WETH per MONEY the pool needs ~18 MONEY for 10 WETH. Taxing the WETH
        // figure instead (the old behaviour) would have charged 1.2 MONEY, not ~2.5.
        assertGt(poolTook, 18 ether);
        assertEq(burned, _grossUp(poolTook, DEPEGGED_RATE_BPS), "tax = net x r / (1 - r), rounded up");
        // Same effective rate as an exact-input sell: tax / gross MONEY paid == tier rate.
        assertApproxEqAbs(burned * 10_000 / paid, DEPEGGED_RATE_BPS, 1, "effective rate must equal the tier rate");
        assertEq(money.balanceOf(address(hook)), 0, "hook retains nothing");
    }

    function test_ExactOutSell_CostsTheSameAsTheEquivalentExactInSell() public {
        _initWithFullRange(DEPEGGED_TICK, DEEP_LIQUIDITY);
        _enableTax();

        uint256 snap = vm.snapshotState();
        uint256 before = money.balanceOf(alice);
        _sellExactOut(alice, 10 ether);
        uint256 paidForExactOut = before - money.balanceOf(alice);
        vm.revertToState(snap);

        // Spend that same gross MONEY amount as an exact-input sell instead.
        uint256 wethBefore = weth.balanceOf(alice);
        _sellExactIn(alice, paidForExactOut);
        assertApproxEqRel(weth.balanceOf(alice) - wethBefore, 10 ether, 1e9, "swap mode must not change the price paid");
    }

    function test_ExactOutSell_RevertsAtAFullTaxRate() public {
        _initWithFullRange(DEPEGGED_TICK, DEEP_LIQUIDITY);
        _enableTax();
        hook.setTaxTiersRate(0, 10_000); // the below-1.12 tier

        vm.prank(alice);
        vm.expectRevert();
        swapRouter.swap(poolKey, _sellParams(int256(1 ether)), PoolSwapTest.TestSettings(false, false), "");
    }

    function test_ExactOutSell_AbovePeg_RoutesToTreasury() public {
        // Money tick 1500 → price ≈ 1.162, tier [1.12, 1.20) = 6%, above the burn threshold.
        _initWithFullRange(1500, DEEP_LIQUIDITY);
        _enableTax();

        uint256 supplyBefore = money.totalSupply();
        uint256 aliceMoneyBefore = money.balanceOf(alice);

        _sellExactOut(alice, 5 ether);

        uint256 paid = aliceMoneyBefore - money.balanceOf(alice);
        uint256 routed = money.balanceOf(treasuryAddr);
        assertEq(money.totalSupply(), supplyBefore, "nothing burned above the threshold");
        assertApproxEqAbs(routed * 10_000 / paid, 600, 1, "treasury receives the tier rate");
    }

    function testFuzz_ExactOutSell_EffectiveRateMatchesTier(
        int256 tickSeed,
        uint256 wethOut
    ) public {
        // Money ticks across every tier: ≈0.49 (−7200) up to ≈1.52 (4200).
        int24 moneyTick = int24(bound(tickSeed, -120, 70)) * 60;
        wethOut = bound(wethOut, 0.01 ether, 500 ether);

        _initWithFullRange(moneyTick, DEEP_LIQUIDITY);
        _enableTax();

        uint256 rate = hook.taxRateForPrice(hook.priceFromTick(_poolTick(moneyTick)));
        uint256 supplyBefore = money.totalSupply();
        uint256 aliceMoneyBefore = money.balanceOf(alice);
        uint256 aliceWethBefore = weth.balanceOf(alice);

        _sellExactOut(alice, wethOut);

        uint256 paid = aliceMoneyBefore - money.balanceOf(alice);
        uint256 tax = (supplyBefore - money.totalSupply()) + money.balanceOf(treasuryAddr);
        assertEq(weth.balanceOf(alice) - aliceWethBefore, wethOut, "exact output honoured");
        assertEq(tax, _grossUp(paid - tax, rate), "tax = net x r / (1 - r), rounded up");
        assertGe(tax * 10_000, paid * rate - 10_000, "effective rate never falls below the tier rate");
        assertApproxEqAbs(tax * 10_000 / paid, rate, 1, "effective rate == tier rate");
    }

    // ------------------------------------------------------------------
    // Buys are never taxed
    // ------------------------------------------------------------------

    function test_Buys_ExactInAndExactOut_AreUntaxed() public {
        _initWithFullRange(DEPEGGED_TICK, DEEP_LIQUIDITY);
        _enableTax();
        uint256 supplyBefore = money.totalSupply();

        _buyExactIn(alice, 10 ether);
        _buyExactOut(alice, 10 ether);

        assertEq(money.totalSupply(), supplyBefore, "no burn on buys");
        assertEq(money.balanceOf(treasuryAddr), 0, "no routing on buys");
    }

    // ------------------------------------------------------------------
    // Batched settlement cannot net the tax away
    // ------------------------------------------------------------------

    function test_BatchedSellThenBuy_InOneUnlock_StillPaysTaxOnTheSellLeg() public {
        _initWithFullRange(DEPEGGED_TICK, DEEP_LIQUIDITY);
        _enableTax();

        PoolKey[] memory keys = new PoolKey[](2);
        SwapParams[] memory swaps = new SwapParams[](2);
        keys[0] = poolKey;
        keys[1] = poolKey;
        swaps[0] = _sellParams(-int256(1000 ether)); // sell 1000 MONEY
        swaps[1] = _buyParams(int256(700 ether)); // buy 700 back in the same unlock

        uint256 supplyBefore = money.totalSupply();
        uint256 aliceBefore = money.balanceOf(alice);

        vm.prank(alice);
        batchRouter.swapBatch(keys, swaps);

        // Flash accounting nets the MONEY legs to 300 for settlement purposes...
        assertEq(aliceBefore - money.balanceOf(alice), 300 ether, "only the net MONEY leg settles");
        // ...but the tax is assessed per swap, on the full 1000 sold.
        assertEq(supplyBefore - money.totalSupply(), 1000 ether * DEPEGGED_RATE_BPS / 10_000, "tax on gross sell");
    }

    // ------------------------------------------------------------------
    // Liquidity cannot be used as a tax-free taker sell
    // ------------------------------------------------------------------

    function test_SingleSidedLiquidity_AddThenRemove_ExtractsNoWeth() public {
        _initWithFullRange(0, DEEP_LIQUIDITY);
        _enableTax();

        // A MONEY-only range sits above the current MONEY price.
        (int24 lower, int24 upper) = _moneyIsCurrency0() ? (int24(60), int24(660)) : (int24(-660), int24(-60));
        uint256 wethBefore = weth.balanceOf(alice);
        uint256 moneyBefore = money.balanceOf(alice);

        ModifyLiquidityParams memory p =
            ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: 5000 ether, salt: bytes32(0)});
        vm.prank(alice);
        liquidityRouter.modifyLiquidity(poolKey, p, "");
        assertEq(weth.balanceOf(alice), wethBefore, "single-sided add needs no WETH");
        assertLt(money.balanceOf(alice), moneyBefore, "MONEY deposited");

        p.liquidityDelta = -5000 ether;
        vm.prank(alice);
        liquidityRouter.modifyLiquidity(poolKey, p, "");

        // Without a counterparty BUY crossing the range there is nothing to withdraw but
        // the MONEY that went in. An LP position is a resting ask, not a market sell.
        assertEq(weth.balanceOf(alice), wethBefore, "no WETH extracted");
        assertApproxEqAbs(money.balanceOf(alice), moneyBefore, 2, "MONEY returned (rounding only)");
    }

    // ------------------------------------------------------------------
    // Liveness: tax collection must not depend on the manager's MONEY reserves
    // ------------------------------------------------------------------

    function test_Sell_WhenManagerHoldsAlmostNoMoney_DefersTaxInsteadOfReverting() public {
        _initPool(0);
        // Concentrated liquidity only. Once price leaves the range upward the position is
        // 100% WETH and the PoolManager holds (almost) no MONEY at all.
        _addLiquidity(-600, 600, 10_000 ether);
        _buyExactIn(bob, 100_000 ether);
        assertLt(money.balanceOf(address(manager)), 1 ether, "manager drained of MONEY");

        _enableTax();
        uint256 aliceBefore = money.balanceOf(alice);
        uint256 supplyBefore = money.totalSupply();
        uint256 moneyId = uint256(uint160(address(money)));

        // Price is far above peg here: 3% tier, routed to Treasury. The sell that pulls
        // price back toward peg must go through even though the tax cannot be paid out yet.
        _sellExactIn(alice, 100 ether);

        assertEq(aliceBefore - money.balanceOf(alice), 100 ether, "sell executed in full");
        assertEq(hook.pendingTaxRoute(), 3 ether, "tax parked for the Treasury");
        assertEq(hook.pendingTaxBurn(), 0);
        assertEq(manager.balanceOf(address(hook), moneyId), 3 ether, "backed 1:1 by PoolManager claims");
        assertEq(money.totalSupply(), supplyBefore, "nothing burned yet");

        // Alice's settled input replenished the manager, so anyone can now flush it.
        vm.prank(stranger);
        hook.settleDeferredTax();

        assertEq(hook.pendingTaxRoute(), 0, "pending cleared");
        assertEq(manager.balanceOf(address(hook), moneyId), 0, "claims redeemed");
        assertEq(money.balanceOf(treasuryAddr), 3 ether, "Treasury paid");
        assertEq(money.balanceOf(address(hook)), 0, "hook retains nothing");
    }

    function test_ExactOutSell_WhenManagerHoldsAlmostNoMoney_AlsoDefers() public {
        _initPool(0);
        _addLiquidity(-600, 600, 10_000 ether);
        _buyExactIn(bob, 100_000 ether);
        _enableTax();

        uint256 aliceBefore = money.balanceOf(alice);
        _sellExactOut(alice, 50 ether);

        uint256 paid = aliceBefore - money.balanceOf(alice);
        uint256 pending = hook.pendingTaxRoute() + hook.pendingTaxBurn();
        assertGt(pending, 0, "tax deferred");
        assertApproxEqAbs(pending * 10_000 / paid, 300, 1, "3% tier applied to the gross MONEY paid");

        hook.settleDeferredTax();
        assertEq(hook.pendingTaxRoute() + hook.pendingTaxBurn(), 0);
    }

    // ------------------------------------------------------------------
    // Oracle integrity
    // ------------------------------------------------------------------

    function test_Twap_IdlePeriodAfterSwap_IntegratesThePostSwapTick() public {
        _initWithFullRange(0, DEEP_LIQUIDITY);
        skip(1 hours);

        _buyExactIn(alice, 5000 ether);
        int24 postSwapTick = _currentPoolTick();
        assertTrue(postSwapTick != 0, "swap moved the price");

        (int56 c1,) = hook.getCurrentTickCumulative();
        skip(6 hours);
        (int56 c2,) = hook.getCurrentTickCumulative();

        assertEq((c2 - c1) / int56(uint56(6 hours)), int56(postSwapTick), "idle time accrues at the resting tick");
    }

    function test_Twap_AtomicRoundTrip_LeavesNoTraceInTheOracle() public {
        _initWithFullRange(0, DEEP_LIQUIDITY);
        Oracle oracle = new Oracle(IPriceSource(address(hook)), address(money), address(weth), 6 hours, block.timestamp);
        skip(1 hours);
        (int56 c1,) = hook.getCurrentTickCumulative();

        // Same block: pump the price ~60%, then sell every MONEY bought straight back.
        BalanceDelta bought = _buyExactIn(alice, 30_000 ether);
        int128 moneyOut = _moneyIsCurrency0() ? bought.amount0() : bought.amount1();
        int24 peakTick = _currentPoolTick();
        _sellExactIn(alice, uint256(uint128(moneyOut)));
        int24 restingTick = _currentPoolTick();

        int24 peakMove = peakTick > 0 ? peakTick : -peakTick;
        int24 restingMove = restingTick > 0 ? restingTick : -restingTick;
        assertGt(peakMove, 4000, "price was pumped hard intra-block");
        assertLt(restingMove, 100, "and returned to roughly where it started");

        skip(6 hours);
        (int56 c2,) = hook.getCurrentTickCumulative();

        assertEq(hook.lastTick(), restingTick, "hook rests at the real pool tick");
        assertEq((c2 - c1) / int56(uint56(6 hours)), int56(restingTick), "TWAP reflects the resting tick only");
        assertApproxEqRel(oracle.twap(address(money), 1 ether), 1 ether, 0.02e18, "oracle price stays at peg");
    }

    function testFuzz_LastTick_AlwaysMatchesThePoolTick(
        uint256[4] memory amounts,
        uint8 directions
    ) public {
        _initWithFullRange(0, DEEP_LIQUIDITY);
        _enableTax();
        for (uint256 i = 0; i < amounts.length; ++i) {
            uint256 amt = bound(amounts[i], 0.001 ether, 5000 ether);
            uint8 mode = (directions >> (2 * i)) & 3;
            if (mode == 0) _sellExactIn(alice, amt);
            else if (mode == 1) _sellExactOut(alice, amt);
            else if (mode == 2) _buyExactIn(alice, amt);
            else _buyExactOut(alice, amt);
            assertEq(hook.lastTick(), _currentPoolTick(), "observation tracks the pool");
            skip(5 minutes);
        }
    }

    // ------------------------------------------------------------------
    // Tax tier follows the TWAP, not the spot price
    // ------------------------------------------------------------------

    function test_TaxTier_CannotBeBoughtDownWithinTheSellTransaction() public {
        _initWithFullRange(0, DEEP_LIQUIDITY);
        Oracle oracle = new Oracle(IPriceSource(address(hook)), address(money), address(weth), 6 hours, block.timestamp);
        hook.setTaxOracle(address(oracle));
        _enableTax();

        // One full epoch resting at peg, then the oracle checkpoints a 1.00 TWAP.
        skip(6 hours);
        oracle.update();
        assertEq(hook.currentTaxRate(), 1200, "TWAP at peg -> 12%");

        // Pump spot far above 1.20 and sell in the same block. A spot-keyed tax would
        // drop to 3%; the TWAP-keyed tax still charges 12%.
        _buyExactIn(alice, 30_000 ether);
        assertGt(hook.priceFromTick(_currentPoolTick()), 1.2e18, "spot is above the 3% threshold");

        uint256 supplyBefore = money.totalSupply();
        _sellExactIn(alice, 1000 ether);
        assertEq(supplyBefore - money.totalSupply(), 120 ether, "12% burned: tier read from the TWAP");
    }

    function test_TaxTier_StepsDownAsTheTwapRises() public {
        // Money tick 1200 → ≈1.127 (6% tier); money tick 1860 → ≈1.204 (3% tier).
        _initWithFullRange(1200, DEEP_LIQUIDITY);
        Oracle oracle = new Oracle(IPriceSource(address(hook)), address(money), address(weth), 6 hours, block.timestamp);
        hook.setTaxOracle(address(oracle));
        _enableTax();

        skip(6 hours);
        oracle.update();
        assertEq(hook.currentTaxRate(), 600, "6% at a ~1.127 TWAP");

        uint256 treasuryBefore = money.balanceOf(treasuryAddr);
        _sellExactIn(alice, 100 ether);
        assertEq(money.balanceOf(treasuryAddr) - treasuryBefore, 6 ether, "6% routed (above the burn threshold)");
    }

    // ------------------------------------------------------------------
    // Known limits — documented, not enforced
    // ------------------------------------------------------------------

    /// @notice MONEY is an unrestricted ERC-20, so anyone can open a hookless pool and trade
    ///         there untaxed. The protocol's answer is incentives (rewards and the oracle
    ///         only recognise the official pool), not transfer gating.
    function test_KnownLimit_HooklessPool_IsUntaxed_ButCannotMoveTheOracle() public {
        _initWithFullRange(DEPEGGED_TICK, DEEP_LIQUIDITY);
        _enableTax();

        PoolKey memory shadow = PoolKey({
            currency0: poolKey.currency0,
            currency1: poolKey.currency1,
            fee: 3000,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(0))
        });
        manager.initialize(shadow, TickMath.getSqrtPriceAtTick(_poolTick(DEPEGGED_TICK)));
        liquidityRouter.modifyLiquidity(
            shadow,
            ModifyLiquidityParams({
                tickLower: FULL_RANGE_LOWER, tickUpper: FULL_RANGE_UPPER, liquidityDelta: 10_000 ether, salt: bytes32(0)
            }),
            ""
        );

        skip(1 hours);
        uint256 supplyBefore = money.totalSupply();
        int24 officialTickBefore = _currentPoolTick();
        (int56 cBefore,) = hook.getCurrentTickCumulative();

        vm.prank(alice);
        swapRouter.swap(shadow, _sellParams(-int256(1000 ether)), PoolSwapTest.TestSettings(false, false), "");

        (int56 cAfter,) = hook.getCurrentTickCumulative();
        assertEq(money.totalSupply(), supplyBefore, "shadow-pool sell is untaxed (accepted limit)");
        assertEq(_currentPoolTick(), officialTickBefore, "official pool price untouched");
        assertEq(cAfter, cBefore, "oracle input untouched");
    }

    /// @notice `sender` in a V4 hook is the ROUTER, not the end user. Excluding an address
    ///         therefore exempts every trader who routes through it.
    function test_KnownLimit_ExcludingARouter_ExemptsAllOfItsUsers() public {
        _initWithFullRange(DEPEGGED_TICK, DEEP_LIQUIDITY);
        _enableTax();
        hook.setExcludedAddress(address(swapRouter), true);

        uint256 supplyBefore = money.totalSupply();
        _sellExactIn(alice, 1000 ether);
        _sellExactIn(bob, 1000 ether);

        assertEq(money.totalSupply(), supplyBefore, "every user of an excluded router trades tax-free");
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev Tax on a net amount such that tax / (net + tax) == rate, rounded up.
    function _grossUp(
        uint256 net,
        uint256 rateBps
    ) internal pure returns (uint256) {
        return (net * rateBps + (10_000 - rateBps) - 1) / (10_000 - rateBps);
    }
}

contract PegDefenseHookAdversarialMoney0Test is PegDefenseHookAdversarialTest {
    function _moneyIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract PegDefenseHookAdversarialMoney1Test is PegDefenseHookAdversarialTest {
    function _moneyIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}
