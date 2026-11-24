// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {HookPoolFixture} from "../utils/HookPoolFixture.t.sol";

import {Oracle} from "../../src/oracle/Oracle.sol";
import {PegDefenseHook} from "../../src/hooks/PegDefenseHook.sol";
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

    /// @dev Peg tick −5940 → price ≈ 0.552 WETH per PEG: below 1.12, so the 12% tier.
    int24 internal constant DEPEGGED_TICK = -5940;
    uint256 internal constant DEPEGGED_RATE_BPS = 1200;

    // ------------------------------------------------------------------
    // Sell tax — exact input
    // ------------------------------------------------------------------

    function test_ExactInSell_TaxIsRateTimesGrossInput() public {
        _initWithFullRange(DEPEGGED_TICK, DEEP_LIQUIDITY);
        _enableTax();

        uint256 gross = 1000 ether;
        uint256 supplyBefore = peg.totalSupply();
        uint256 aliceBefore = peg.balanceOf(alice);

        _sellExactIn(alice, gross);

        uint256 burned = supplyBefore - peg.totalSupply();
        assertEq(aliceBefore - peg.balanceOf(alice), gross, "seller pays exactly the specified input");
        assertEq(burned, gross * DEPEGGED_RATE_BPS / 10_000, "tax = rate x gross input");
        assertEq(peg.balanceOf(address(hook)), 0, "hook retains nothing");
    }

    // ------------------------------------------------------------------
    // Sell tax — exact output (unit-mixing regression)
    // ------------------------------------------------------------------

    function test_ExactOutSell_TaxIsChargedOnPegNotOnWethOutput() public {
        _initWithFullRange(DEPEGGED_TICK, DEEP_LIQUIDITY);
        _enableTax();

        uint256 wethOut = 10 ether;
        uint256 supplyBefore = peg.totalSupply();
        uint256 alicePegBefore = peg.balanceOf(alice);
        uint256 aliceWethBefore = weth.balanceOf(alice);

        _sellExactOut(alice, wethOut);

        uint256 burned = supplyBefore - peg.totalSupply();
        uint256 paid = alicePegBefore - peg.balanceOf(alice);
        uint256 poolTook = paid - burned;

        assertEq(weth.balanceOf(alice) - aliceWethBefore, wethOut, "seller receives exactly the specified output");
        // At ~0.55 WETH per PEG the pool needs ~18 PEG for 10 WETH. Taxing the WETH
        // figure instead (the old behaviour) would have charged 1.2 PEG, not ~2.5.
        assertGt(poolTook, 18 ether);
        assertEq(burned, _grossUp(poolTook, DEPEGGED_RATE_BPS), "tax = net x r / (1 - r), rounded up");
        // Same effective rate as an exact-input sell: tax / gross PEG paid == tier rate.
        assertApproxEqAbs(burned * 10_000 / paid, DEPEGGED_RATE_BPS, 1, "effective rate must equal the tier rate");
        assertEq(peg.balanceOf(address(hook)), 0, "hook retains nothing");
    }

    function test_ExactOutSell_CostsTheSameAsTheEquivalentExactInSell() public {
        _initWithFullRange(DEPEGGED_TICK, DEEP_LIQUIDITY);
        _enableTax();

        uint256 snap = vm.snapshotState();
        uint256 before = peg.balanceOf(alice);
        _sellExactOut(alice, 10 ether);
        uint256 paidForExactOut = before - peg.balanceOf(alice);
        vm.revertToState(snap);

        // Spend that same gross PEG amount as an exact-input sell instead.
        uint256 wethBefore = weth.balanceOf(alice);
        _sellExactIn(alice, paidForExactOut);
        assertApproxEqRel(weth.balanceOf(alice) - wethBefore, 10 ether, 1e9, "swap mode must not change the price paid");
    }

    function test_ExactOutSell_AbovePeg_RoutesToTreasury() public {
        // Peg tick 1500 → price ≈ 1.162, tier [1.12, 1.20) = 6%, above the burn threshold.
        _initWithFullRange(1500, DEEP_LIQUIDITY);
        _enableTax();
        _earnTargetRate();

        uint256 supplyBefore = peg.totalSupply();
        uint256 alicePegBefore = peg.balanceOf(alice);

        _sellExactOut(alice, 5 ether);

        uint256 paid = alicePegBefore - peg.balanceOf(alice);
        uint256 routed = peg.balanceOf(treasuryAddr);
        assertEq(peg.totalSupply(), supplyBefore, "nothing burned above the threshold");
        assertApproxEqAbs(routed * 10_000 / paid, 600, 1, "treasury receives the tier rate");
    }

    function testFuzz_ExactOutSell_EffectiveRateMatchesTier(
        int256 tickSeed,
        uint256 wethOut
    ) public {
        // Peg ticks across every tier: ≈0.49 (−7200) up to ≈1.52 (4200).
        int24 pegTick = int24(bound(tickSeed, -120, 70)) * 60;
        wethOut = bound(wethOut, 0.01 ether, 500 ether);

        _initWithFullRange(pegTick, DEEP_LIQUIDITY);
        _enableTax();
        _earnTargetRate();

        uint256 rate = hook.taxRate();
        assertEq(rate, hook.taxRateForPrice(hook.priceFromTick(_poolTick(pegTick))), "rate settled on the tier");
        uint256 supplyBefore = peg.totalSupply();
        uint256 alicePegBefore = peg.balanceOf(alice);
        uint256 aliceWethBefore = weth.balanceOf(alice);

        _sellExactOut(alice, wethOut);

        uint256 paid = alicePegBefore - peg.balanceOf(alice);
        uint256 tax = (supplyBefore - peg.totalSupply()) + peg.balanceOf(treasuryAddr);
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
        uint256 supplyBefore = peg.totalSupply();

        _buyExactIn(alice, 10 ether);
        _buyExactOut(alice, 10 ether);

        assertEq(peg.totalSupply(), supplyBefore, "no burn on buys");
        assertEq(peg.balanceOf(treasuryAddr), 0, "no routing on buys");
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
        swaps[0] = _sellParams(-int256(1000 ether)); // sell 1000 PEG
        swaps[1] = _buyParams(int256(700 ether)); // buy 700 back in the same unlock

        uint256 supplyBefore = peg.totalSupply();
        uint256 aliceBefore = peg.balanceOf(alice);

        vm.prank(alice);
        batchRouter.swapBatch(keys, swaps);

        // Flash accounting nets the PEG legs to 300 for settlement purposes...
        assertEq(aliceBefore - peg.balanceOf(alice), 300 ether, "only the net PEG leg settles");
        // ...but the tax is assessed per swap, on the full 1000 sold.
        assertEq(supplyBefore - peg.totalSupply(), 1000 ether * DEPEGGED_RATE_BPS / 10_000, "tax on gross sell");
    }

    // ------------------------------------------------------------------
    // Liquidity cannot be used as a tax-free taker sell
    // ------------------------------------------------------------------

    function test_SingleSidedLiquidity_AddThenRemove_ExtractsNoWeth() public {
        _initWithFullRange(0, DEEP_LIQUIDITY);
        _enableTax();

        // A PEG-only range sits above the current PEG price.
        (int24 lower, int24 upper) = _pegIsCurrency0() ? (int24(60), int24(660)) : (int24(-660), int24(-60));
        uint256 wethBefore = weth.balanceOf(alice);
        uint256 pegBefore = peg.balanceOf(alice);

        ModifyLiquidityParams memory p =
            ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: 5000 ether, salt: bytes32(0)});
        vm.prank(alice);
        liquidityRouter.modifyLiquidity(poolKey, p, "");
        assertEq(weth.balanceOf(alice), wethBefore, "single-sided add needs no WETH");
        assertLt(peg.balanceOf(alice), pegBefore, "PEG deposited");

        p.liquidityDelta = -5000 ether;
        vm.prank(alice);
        liquidityRouter.modifyLiquidity(poolKey, p, "");

        // Without a counterparty BUY crossing the range there is nothing to withdraw but
        // the PEG that went in. An LP position is a resting ask, not a market sell.
        assertEq(weth.balanceOf(alice), wethBefore, "no WETH extracted");
        assertApproxEqAbs(peg.balanceOf(alice), pegBefore, 2, "PEG returned (rounding only)");
    }

    // ------------------------------------------------------------------
    // Liveness: tax collection must not depend on the manager's PEG reserves
    // ------------------------------------------------------------------

    function test_Sell_WhenManagerHoldsAlmostNoPeg_DefersTaxInsteadOfReverting() public {
        _initPool(0);
        // Concentrated liquidity only. Once price leaves the range upward the position is
        // 100% WETH and the PoolManager holds (almost) no PEG at all.
        _addLiquidity(-600, 600, 10_000 ether);
        _buyExactIn(bob, 100_000 ether);
        assertLt(peg.balanceOf(address(manager)), 1 ether, "manager drained of PEG");

        _enableTax();
        _earnTargetRate();
        uint256 aliceBefore = peg.balanceOf(alice);
        uint256 supplyBefore = peg.totalSupply();
        uint256 treasuryBefore = peg.balanceOf(treasuryAddr);
        uint256 pegId = uint256(uint160(address(peg)));

        // Price is far above peg here: 3% tier, routed to Treasury. The sell that pulls
        // price back toward peg must go through even though the tax cannot be paid out yet.
        _sellExactIn(alice, 100 ether);

        assertEq(aliceBefore - peg.balanceOf(alice), 100 ether, "sell executed in full");
        assertEq(hook.pendingTaxRoute(), 3 ether, "tax parked for the Treasury");
        assertEq(hook.pendingTaxBurn(), 0);
        assertEq(manager.balanceOf(address(hook), pegId), 3 ether, "backed 1:1 by PoolManager claims");
        assertEq(peg.totalSupply(), supplyBefore, "nothing burned yet");
        _assertTaxAccounting(supplyBefore, treasuryBefore);

        (uint256 pb, uint256 pr, uint256 claims, uint256 settleable) = hook.deferredTaxStatus();
        assertEq(pb + pr, 3 ether);
        assertEq(claims, 3 ether, "monitor sees full backing");
        assertEq(settleable, 3 ether, "the settled sell made it redeemable");

        // Alice's settled input replenished the manager, so anyone can now flush it.
        vm.prank(stranger);
        (uint256 burned, uint256 routed) = hook.settleDeferredTax();

        assertEq(burned, 0);
        assertEq(routed, 3 ether, "the call reports what it settled");
        _assertTaxAccounting(supplyBefore, treasuryBefore);
        assertEq(hook.pendingTaxRoute(), 0, "pending cleared");
        assertEq(manager.balanceOf(address(hook), pegId), 0, "claims redeemed");
        assertEq(peg.balanceOf(treasuryAddr), 3 ether, "Treasury paid");
        assertEq(peg.balanceOf(address(hook)), 0, "hook retains nothing");
    }

    function test_ExactOutSell_WhenManagerHoldsAlmostNoPeg_AlsoDefers() public {
        _initPool(0);
        _addLiquidity(-600, 600, 10_000 ether);
        _buyExactIn(bob, 100_000 ether);
        _enableTax();
        _earnTargetRate();

        uint256 aliceBefore = peg.balanceOf(alice);
        _sellExactOut(alice, 50 ether);

        uint256 paid = aliceBefore - peg.balanceOf(alice);
        uint256 pending = hook.pendingTaxRoute() + hook.pendingTaxBurn();
        assertGt(pending, 0, "tax deferred");
        assertApproxEqAbs(pending * 10_000 / paid, 300, 1, "3% tier applied to the gross PEG paid");

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
        Oracle oracle = new Oracle(IPriceSource(address(hook)), address(peg), address(weth), 6 hours, block.timestamp);
        skip(1 hours);
        (int56 c1,) = hook.getCurrentTickCumulative();

        // Same block: pump the price ~60%, then sell every PEG bought straight back.
        BalanceDelta bought = _buyExactIn(alice, 30_000 ether);
        int128 pegOut = _pegIsCurrency0() ? bought.amount0() : bought.amount1();
        int24 peakTick = _currentPoolTick();
        _sellExactIn(alice, uint256(uint128(pegOut)));
        int24 restingTick = _currentPoolTick();

        int24 peakMove = peakTick > 0 ? peakTick : -peakTick;
        int24 restingMove = restingTick > 0 ? restingTick : -restingTick;
        assertGt(peakMove, 4000, "price was pumped hard intra-block");
        assertLt(restingMove, 100, "and returned to roughly where it started");

        skip(6 hours);
        (int56 c2,) = hook.getCurrentTickCumulative();

        assertEq(hook.lastTick(), restingTick, "hook rests at the real pool tick");
        assertEq((c2 - c1) / int56(uint56(6 hours)), int56(restingTick), "TWAP reflects the resting tick only");
        assertApproxEqRel(oracle.twap(address(peg), 1 ether), 1 ether, 0.02e18, "oracle price stays at peg");
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
        Oracle oracle = new Oracle(IPriceSource(address(hook)), address(peg), address(weth), 6 hours, block.timestamp);
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

        uint256 supplyBefore = peg.totalSupply();
        _sellExactIn(alice, 1000 ether);
        assertEq(supplyBefore - peg.totalSupply(), 120 ether, "12% burned: tier read from the TWAP");
    }

    function test_FireTax_FallsOnlyAfterSevenHours_AndRisesAtOnce() public {
        // Peg tick 1200 → ≈1.127: the schedule's target is 6%.
        _initWithFullRange(1200, DEEP_LIQUIDITY);
        _enableTax();

        uint256 supplyBefore = peg.totalSupply();
        _sellExactIn(alice, 100 ether);
        assertEq(hook.taxRate(), 1200, "starts at the maximum");
        // 1.127 is above the burn threshold, so the 12% is routed, not burned.
        assertEq(peg.totalSupply(), supplyBefore);
        assertEq(peg.balanceOf(treasuryAddr), 12 ether, "12% charged while the lower rate is unearned");

        (uint256 toRate, uint256 readyAt) = hook.pendingTaxDecrease();
        assertEq(toRate, 600, "a decrease to 6% is pending");
        assertEq(readyAt, block.timestamp + 7 hours);

        skip(7 hours - 1);
        _sellExactIn(alice, 100 ether);
        assertEq(peg.balanceOf(treasuryAddr), 24 ether, "still 12% one second before the window closes");

        skip(1);
        _sellExactIn(alice, 100 ether);
        assertEq(hook.taxRate(), 600);
        assertEq(peg.balanceOf(treasuryAddr), 30 ether, "6% once the seven hours have run");

        // Tighten the schedule: the higher rate bites on the very next swap.
        hook.setTaxTiersRate(1, 1100);
        _sellExactIn(alice, 100 ether);
        assertEq(hook.taxRate(), 1100, "increases are immediate");
        assertEq(peg.balanceOf(treasuryAddr), 41 ether);
    }

    function test_FireTax_NoSetterOrPathCanExceedTwelvePercent() public {
        for (uint256 i = 0; i < 3; ++i) {
            vm.expectRevert(PegDefenseHook.TaxRateTooHigh.selector);
            hook.setTaxTiersRate(i, 1201);
        }
        assertEq(hook.MAX_TAX_BPS(), 1200);
        assertEq(hook.taxRate(), 1200);
    }

    // ------------------------------------------------------------------
    // Deferred tax: partial settlement, retries, conservation
    // ------------------------------------------------------------------

    function test_DeferredTax_StaysFullyBacked_EvenIfThePoolIsDrainedAgain() public {
        _initPool(0);
        _addLiquidity(-600, 600, 10_000 ether);
        _buyExactIn(bob, 100_000 ether); // pool is now ~100% WETH
        _enableTax();
        uint256 supplyBefore = peg.totalSupply();
        uint256 treasuryBefore = peg.balanceOf(treasuryAddr);

        // Still inside the first recovery window: 12%, routed (price is far above 1.10).
        _sellExactIn(alice, 100 ether);
        assertEq(hook.pendingTaxRoute(), 12 ether);

        // Buyers take every PEG the pool holds. The claim's backing is not the pool's to
        // give: the seller's settled input covers it, so it survives the drain.
        _buyExactIn(bob, 100_000 ether);
        (,, uint256 claims, uint256 settleable) = hook.deferredTaxStatus();
        assertEq(claims, 12 ether);
        assertEq(settleable, 12 ether, "still redeemable in full");
        _assertTaxAccounting(supplyBefore, treasuryBefore);

        (uint256 burned, uint256 routed) = hook.settleDeferredTax();
        assertEq(burned, 0);
        assertEq(routed, 12 ether);
        _assertTaxAccounting(supplyBefore, treasuryBefore);

        // Retrying with nothing owed is a harmless no-op, not a revert.
        (burned, routed) = hook.settleDeferredTax();
        assertEq(burned + routed, 0);
        _assertTaxAccounting(supplyBefore, treasuryBefore);
    }

    function test_DeferredTax_TreasuryUnsetBeforeSettlement_FallsBackToBurn() public {
        _initPool(0);
        _addLiquidity(-600, 600, 10_000 ether);
        _buyExactIn(bob, 100_000 ether);
        _enableTax();
        uint256 supplyBefore = peg.totalSupply();
        uint256 treasuryBefore = peg.balanceOf(treasuryAddr);

        _sellExactIn(alice, 100 ether);
        assertEq(hook.pendingTaxRoute(), 12 ether);

        hook.setTreasury(address(0));
        (uint256 burned, uint256 routed) = hook.settleDeferredTax();
        assertEq(burned, 12 ether, "no Treasury to pay: burned instead");
        assertEq(routed, 0);
        _assertTaxAccounting(supplyBefore, treasuryBefore);
    }

    function testFuzz_TaxAccounting_ConservedAcrossAnySequence(
        uint256[10] memory seeds
    ) public {
        _initPool(0);
        // Thin, concentrated liquidity so sequences really do run the manager dry.
        _addLiquidity(-600, 600, 10_000 ether);
        _enableTax();
        uint256 supplyBefore = peg.totalSupply();
        uint256 treasuryBefore = peg.balanceOf(treasuryAddr);

        for (uint256 i = 0; i < seeds.length; ++i) {
            uint256 op = seeds[i] % 7;
            uint256 amount = bound(seeds[i] >> 8, 0.01 ether, 3000 ether);
            // A swap the router rejects (e.g. starting at the price limit) changes nothing.
            if (op == 0) {
                try this.swapExternal(alice, _sellParams(-int256(amount))) {} catch {}
            } else if (op == 1) {
                try this.swapExternal(alice, _sellParams(int256(amount / 20))) {} catch {}
            } else if (op == 2) {
                try this.swapExternal(bob, _buyParams(-int256(amount * 30))) {} catch {}
            } else if (op == 3) {
                try this.swapExternal(bob, _buyParams(int256(amount / 20))) {} catch {}
            } else if (op == 4) {
                hook.settleDeferredTax();
            } else if (op == 5) {
                skip(4 hours);
            } else {
                hook.pokeTaxRate();
            }
            _assertTaxAccounting(supplyBefore, treasuryBefore);
        }
    }

    // ------------------------------------------------------------------
    // Known limits — documented, not enforced
    // ------------------------------------------------------------------

    /// @notice PEG is an unrestricted ERC-20, so anyone can open a hookless pool and trade
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
        uint256 supplyBefore = peg.totalSupply();
        int24 officialTickBefore = _currentPoolTick();
        (int56 cBefore,) = hook.getCurrentTickCumulative();

        vm.prank(alice);
        swapRouter.swap(shadow, _sellParams(-int256(1000 ether)), PoolSwapTest.TestSettings(false, false), "");

        (int56 cAfter,) = hook.getCurrentTickCumulative();
        assertEq(peg.totalSupply(), supplyBefore, "shadow-pool sell is untaxed (accepted limit)");
        assertEq(_currentPoolTick(), officialTickBefore, "official pool price untouched");
        assertEq(cAfter, cBefore, "oracle input untouched");
    }

    /// @notice `sender` in a V4 hook is the ROUTER, not the end user. Excluding an address
    ///         therefore exempts every trader who routes through it.
    function test_KnownLimit_ExcludingARouter_ExemptsAllOfItsUsers() public {
        _initWithFullRange(DEPEGGED_TICK, DEEP_LIQUIDITY);
        _enableTax();
        hook.setExcludedAddress(address(swapRouter), true);

        uint256 supplyBefore = peg.totalSupply();
        _sellExactIn(alice, 1000 ether);
        _sellExactIn(bob, 1000 ether);

        assertEq(peg.totalSupply(), supplyBefore, "every user of an excluded router trades tax-free");
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

contract PegDefenseHookAdversarialPeg0Test is PegDefenseHookAdversarialTest {
    function _pegIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract PegDefenseHookAdversarialPeg1Test is PegDefenseHookAdversarialTest {
    function _pegIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}
