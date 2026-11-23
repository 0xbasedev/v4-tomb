// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {HookPoolFixture, FixtureWeth} from "../utils/HookPoolFixture.t.sol";

import {ShareBuybackHook, ShareBuybackHookPermissions, IFireTaxSource} from "../../src/hooks/ShareBuybackHook.sol";
import {BaseV4Hook} from "../../src/hooks/base/BaseV4Hook.sol";
import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";
import {Trustees} from "../../src/governance/Trustees.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

/// @dev A Fire Tax source the test controls directly.
contract StubFireTax {
    uint256 public rate;
    bool public broken;

    function set(
        uint256 newRate
    ) external {
        rate = newRate;
    }

    function setBroken(
        bool isBroken
    ) external {
        broken = isBroken;
    }

    function pokeTaxRate() external view returns (uint256) {
        require(!broken, "fire tax source down");
        return rate;
    }
}

/**
 * @title ShareBuybackHookTest
 * @notice SHARE sell tax → QUOTE → PEG → burn, against a real v4-core PoolManager with the
 *         real PegDefenseHook on the peg pool. In this fixture SHARE is a plain ERC-20,
 *         QUOTE is the fixture's WETH and PEG is MONEY; the hook itself only knows them as
 *         addresses, so the same tests describe SQUARE / USDC / LEVEL.
 *
 *         Runs in every combination of token ordering for both pools.
 */
abstract contract ShareBuybackHookTest is HookPoolFixture {
    FixtureWeth internal share;
    ShareBuybackHook internal shareHook;
    PoolKey internal sharePoolKey;

    int256 internal constant SHARE_LIQUIDITY = 50_000 ether;
    int256 internal constant PEG_LIQUIDITY = 100_000 ether;

    function _shareIsCurrency0() internal pure virtual returns (bool);

    function setUp() public virtual override {
        super.setUp();

        // Two slots away from WETH so it can never land on MONEY's address.
        address shareAddr =
            _shareIsCurrency0() ? address(uint160(address(weth)) - 2) : address(uint160(address(weth)) + 2);
        deployCodeTo("HookPoolFixture.t.sol:FixtureWeth", shareAddr);
        share = FixtureWeth(shareAddr);

        shareHook = _deployShareHook(IFireTaxSource(address(hook)), 0xCAFE);

        sharePoolKey = _sharePoolKeyFor(shareHook);

        for (uint256 i = 0; i < 3; ++i) {
            address who = i == 0 ? address(this) : i == 1 ? alice : bob;
            share.mint(who, ACTOR_BALANCE);
            vm.startPrank(who);
            share.approve(address(swapRouter), type(uint256).max);
            share.approve(address(liquidityRouter), type(uint256).max);
            vm.stopPrank();
        }

        // Peg pool at parity, share pool at 1 SHARE = 1 QUOTE, both deep.
        _initWithFullRange(0, PEG_LIQUIDITY);
        manager.initialize(sharePoolKey, TickMath.getSqrtPriceAtTick(0));
        liquidityRouter.modifyLiquidity(
            sharePoolKey,
            ModifyLiquidityParams({
                tickLower: FULL_RANGE_LOWER,
                tickUpper: FULL_RANGE_UPPER,
                liquidityDelta: SHARE_LIQUIDITY,
                salt: bytes32(0)
            }),
            ""
        );
        shareHook.setTaxEnabled(true);
    }

    function _deployShareHook(
        IFireTaxSource source,
        uint160 tag
    ) internal returns (ShareBuybackHook) {
        address at = address(ShareBuybackHookPermissions.FLAGS | (tag << 144));
        deployCodeTo(
            "ShareBuybackHook.sol:ShareBuybackHook",
            abi.encode(
                IPoolManager(address(manager)),
                address(share),
                address(money),
                poolKey,
                source,
                IPriceSource(address(hook)),
                address(this)
            ),
            at
        );
        return ShareBuybackHook(at);
    }

    function _sharePoolKeyFor(
        ShareBuybackHook h
    ) internal view returns (PoolKey memory) {
        (Currency c0, Currency c1) = _shareIsCurrency0()
            ? (Currency.wrap(address(share)), Currency.wrap(address(weth)))
            : (Currency.wrap(address(weth)), Currency.wrap(address(share)));
        return PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: TICK_SPACING, hooks: IHooks(address(h))});
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _shareSwap(
        address who,
        bool sell,
        int256 amountSpecified
    ) internal returns (BalanceDelta delta) {
        bool zeroForOne = sell ? _shareIsCurrency0() : !_shareIsCurrency0();
        vm.prank(who);
        delta = swapRouter.swap(
            sharePoolKey, _params(zeroForOne, amountSpecified), PoolSwapTest.TestSettings(false, false), ""
        );
    }

    function shareSwapExternal(
        address who,
        bool sell,
        int256 amountSpecified
    ) external {
        _shareSwap(who, sell, amountSpecified);
    }

    function _quoteClaims() internal view returns (uint256) {
        return manager.balanceOf(address(shareHook), uint256(uint160(address(weth))));
    }

    /// @dev Every taxed unit is either converted or still pending and fully backed; the
    ///      hook itself never holds a token; and every PEG it bought has left the supply.
    function _assertShareAccounting(
        uint256 pegSupplyAtStart
    ) internal view {
        assertEq(
            shareHook.totalQuoteAssessed(),
            shareHook.totalQuoteConverted() + shareHook.pendingQuote(),
            "assessed == converted + pending"
        );
        assertEq(_quoteClaims(), shareHook.pendingQuote(), "claims back pending tax 1:1");
        assertGe(weth.balanceOf(address(manager)), shareHook.pendingQuote(), "reserves cover the claims");
        assertEq(weth.balanceOf(address(shareHook)), 0, "hook holds no QUOTE");
        assertEq(money.balanceOf(address(shareHook)), 0, "hook holds no PEG");
        assertEq(share.balanceOf(address(shareHook)), 0, "hook holds no SHARE");
        assertEq(
            pegSupplyAtStart - money.totalSupply(),
            shareHook.totalPegBurned() + hook.totalTaxBurned(),
            "every PEG bought was burned"
        );
    }

    // ------------------------------------------------------------------
    // Collection
    // ------------------------------------------------------------------

    function test_ExactInSell_TaxIsRateTimesQuoteProceeds() public {
        uint256 wethBefore = weth.balanceOf(alice);
        uint256 shareBefore = share.balanceOf(alice);
        uint256 supplyBefore = money.totalSupply();

        _shareSwap(alice, true, -int256(100 ether));

        uint256 received = weth.balanceOf(alice) - wethBefore;
        uint256 tax = shareHook.pendingQuote();
        assertEq(shareBefore - share.balanceOf(alice), 100 ether, "seller pays exactly the specified SHARE");
        // The Fire Tax starts at its 12% maximum.
        assertEq(tax, (received + tax) * 1200 / 10_000, "tax = 12% of gross proceeds");
        _assertShareAccounting(supplyBefore);
    }

    function test_ExactOutSell_SellerGetsExactlyWhatTheyAskedFor() public {
        uint256 wethBefore = weth.balanceOf(alice);
        uint256 supplyBefore = money.totalSupply();

        _shareSwap(alice, true, int256(50 ether));

        uint256 tax = shareHook.pendingQuote();
        assertEq(weth.balanceOf(alice) - wethBefore, 50 ether, "exact output honoured");
        assertEq(tax, (uint256(50 ether) * 1200 + 8799) / 8800, "tax = W x r / (1 - r), rounded up");
        assertApproxEqAbs(tax * 10_000 / (50 ether + tax), 1200, 1, "12% of gross proceeds");
        _assertShareAccounting(supplyBefore);
    }

    function test_BothSwapModes_CostTheSame() public {
        uint256 snap = vm.snapshotState();
        uint256 before = share.balanceOf(alice);
        _shareSwap(alice, true, int256(50 ether));
        uint256 sharePaid = before - share.balanceOf(alice);
        vm.revertToState(snap);

        uint256 wethBefore = weth.balanceOf(alice);
        _shareSwap(alice, true, -int256(sharePaid));
        assertApproxEqRel(weth.balanceOf(alice) - wethBefore, 50 ether, 1e9, "swap mode must not change the outcome");
    }

    function test_Buys_AreNeverTaxed() public {
        _shareSwap(alice, false, -int256(100 ether));
        _shareSwap(alice, false, int256(100 ether));
        assertEq(shareHook.pendingQuote(), 0);
        assertEq(shareHook.totalQuoteAssessed(), 0);
    }

    function test_TaxDisabled_CollectsNothing() public {
        shareHook.setTaxEnabled(false);
        _shareSwap(alice, true, -int256(100 ether));
        _shareSwap(alice, true, int256(10 ether));
        assertEq(shareHook.pendingQuote(), 0);
    }

    // ------------------------------------------------------------------
    // Rate: one Fire Tax for both tokens, capped here too
    // ------------------------------------------------------------------

    function test_Rate_FollowsThePegHooksRatchet() public {
        // Tighten nothing; just move the schedule so the target at parity is 6%.
        hook.setTaxTiersRate(0, 600);
        // A sell right now still pays 12%: the decrease has to stand for seven hours.
        uint256 wethBefore = weth.balanceOf(alice);
        _shareSwap(alice, true, -int256(100 ether));
        uint256 received = weth.balanceOf(alice) - wethBefore;
        assertEq(shareHook.pendingQuote(), (received + shareHook.pendingQuote()) * 1200 / 10_000, "12% until earned");

        // That sell also opened the recovery window on the peg hook.
        skip(7 hours);
        uint256 pendingBefore = shareHook.pendingQuote();
        wethBefore = weth.balanceOf(alice);
        _shareSwap(alice, true, -int256(100 ether));
        received = weth.balanceOf(alice) - wethBefore;
        uint256 tax = shareHook.pendingQuote() - pendingBefore;
        assertEq(tax, (received + tax) * 600 / 10_000, "6% once the seven hours have run");

        // Raising it again bites on the very next sell.
        hook.setTaxTiersRate(0, 1200);
        pendingBefore = shareHook.pendingQuote();
        wethBefore = weth.balanceOf(alice);
        _shareSwap(alice, true, -int256(100 ether));
        received = weth.balanceOf(alice) - wethBefore;
        tax = shareHook.pendingQuote() - pendingBefore;
        assertEq(tax, (received + tax) * 1200 / 10_000, "increase is immediate");
    }

    function test_Rate_IsCappedAtTwelvePercent_WhateverTheSourceSays() public {
        StubFireTax stub = new StubFireTax();
        stub.set(9000);
        (ShareBuybackHook capped, PoolKey memory key) = _secondSharePool(stub);

        uint256 wethBefore = weth.balanceOf(alice);
        vm.prank(alice);
        swapRouter.swap(
            key, _params(_shareIsCurrency0(), -int256(100 ether)), PoolSwapTest.TestSettings(false, false), ""
        );
        uint256 received = weth.balanceOf(alice) - wethBefore;
        uint256 tax = capped.pendingQuote();
        assertEq(capped.MAX_TAX_BPS(), 1200);
        assertEq(tax, (received + tax) * 1200 / 10_000, "a 90% source still charges 12%");
    }

    function test_Rate_BrokenSource_DoesNotBlockTheSell_AndStillTaxes() public {
        StubFireTax stub = new StubFireTax();
        stub.setBroken(true);
        (ShareBuybackHook h, PoolKey memory key) = _secondSharePool(stub);

        uint256 wethBefore = weth.balanceOf(alice);
        vm.prank(alice);
        swapRouter.swap(
            key, _params(_shareIsCurrency0(), -int256(100 ether)), PoolSwapTest.TestSettings(false, false), ""
        );
        assertGt(weth.balanceOf(alice), wethBefore, "sell went through");
        assertGt(h.pendingQuote(), 0, "and was taxed at the ceiling");
    }

    /// @dev A second SHARE/QUOTE pool with its own hook wired to a stub rate source.
    function _secondSharePool(
        StubFireTax stub
    ) internal returns (ShareBuybackHook h, PoolKey memory key) {
        h = _deployShareHook(IFireTaxSource(address(stub)), 0xD00D);
        key = _sharePoolKeyFor(h);
        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));
        liquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: FULL_RANGE_LOWER,
                tickUpper: FULL_RANGE_UPPER,
                liquidityDelta: SHARE_LIQUIDITY,
                salt: bytes32(0)
            }),
            ""
        );
        h.setTaxEnabled(true);
    }

    // ------------------------------------------------------------------
    // Convert and burn
    // ------------------------------------------------------------------

    function test_Buyback_ConvertsEverything_AndBurnsAllOfIt() public {
        uint256 supplyBefore = money.totalSupply();
        _shareSwap(alice, true, -int256(1000 ether));
        uint256 pending = shareHook.pendingQuote();
        assertGt(pending, 0);

        (,, uint256 readyAt) = shareHook.buybackStatus();
        assertEq(readyAt, block.timestamp + 30 minutes, "the sell started the TWAP span");

        skip(30 minutes);
        vm.prank(stranger); // anyone
        (uint256 quoteSpent, uint256 pegBurned) = shareHook.executeBuyback();

        assertEq(quoteSpent, pending, "all pending QUOTE converted");
        assertGt(pegBurned, 0);
        assertEq(supplyBefore - money.totalSupply(), pegBurned, "100% of the PEG bought is burned");
        assertEq(shareHook.pendingQuote(), 0);
        assertEq(money.balanceOf(stranger), 0, "the caller gains nothing");
        _assertShareAccounting(supplyBefore);
    }

    function test_Buyback_WaitsForTheTwapSpan() public {
        _shareSwap(alice, true, -int256(1000 ether));
        uint256 pending = shareHook.pendingQuote();

        skip(30 minutes - 1);
        (uint256 quoteSpent,) = shareHook.executeBuyback();
        assertEq(quoteSpent, 0, "span too short");
        assertEq(shareHook.pendingQuote(), pending, "nothing lost by calling early");

        skip(1);
        (quoteSpent,) = shareHook.executeBuyback();
        assertEq(quoteSpent, pending);
    }

    function test_Buyback_CannotSettleTheSameTaxTwice() public {
        uint256 supplyBefore = money.totalSupply();
        _shareSwap(alice, true, -int256(1000 ether));
        skip(30 minutes);

        (uint256 first,) = shareHook.executeBuyback();
        uint256 supplyAfterFirst = money.totalSupply();
        (uint256 second, uint256 secondBurn) = shareHook.executeBuyback();

        assertGt(first, 0);
        assertEq(second, 0, "second call finds nothing to convert");
        assertEq(secondBurn, 0);
        assertEq(money.totalSupply(), supplyAfterFirst);
        assertEq(shareHook.totalQuoteConverted(), first);
        _assertShareAccounting(supplyBefore);
    }

    function test_Buyback_RefusesToBuyIntoAPumpedPrice() public {
        uint256 supplyBefore = money.totalSupply();
        _shareSwap(alice, true, -int256(1000 ether));
        uint256 pending = shareHook.pendingQuote();
        skip(30 minutes);

        // Sandwich attempt: pump PEG in the same block, then trigger the buyback.
        _buyExactIn(bob, 20_000 ether);
        (uint256 quoteSpent, uint256 pegBurned) = shareHook.executeBuyback();

        assertEq(quoteSpent, 0, "no purchase at a manipulated price");
        assertEq(pegBurned, 0);
        assertEq(shareHook.pendingQuote(), pending, "the tax stays pending, fully accounted");
        _assertShareAccounting(supplyBefore);
    }

    function test_Buyback_FillsPartially_WhenThePriceLimitIsReached() public {
        uint256 supplyBefore = money.totalSupply();
        // Enough tax that buying it all would move PEG more than the 1% guard allows.
        _shareSwap(alice, true, -int256(20_000 ether));
        uint256 pending = shareHook.pendingQuote();
        skip(30 minutes);

        (uint256 quoteSpent, uint256 pegBurned) = shareHook.executeBuyback();
        assertGt(quoteSpent, 0, "bought up to the limit");
        assertLt(quoteSpent, pending, "and stopped there");
        assertEq(shareHook.pendingQuote(), pending - quoteSpent, "remainder stays pending");
        assertEq(supplyBefore - money.totalSupply(), pegBurned);
        _assertShareAccounting(supplyBefore);
    }

    function test_Buyback_ThatCannotRun_NeverBlocksASell() public {
        // Remove every bit of PEG liquidity: no buyback can execute at all.
        _addLiquidity(FULL_RANGE_LOWER, FULL_RANGE_UPPER, -PEG_LIQUIDITY);
        uint256 supplyBefore = money.totalSupply();

        _shareSwap(alice, true, -int256(100 ether));
        _shareSwap(alice, true, int256(10 ether));
        uint256 pending = shareHook.pendingQuote();
        assertGt(pending, 0, "sells still execute and are still taxed");

        skip(30 minutes);
        (uint256 quoteSpent,) = shareHook.executeBuyback();
        assertEq(quoteSpent, 0, "nothing to buy from");
        assertEq(shareHook.pendingQuote(), pending, "tax waits, fully backed");
        _assertShareAccounting(supplyBefore);
    }

    // ------------------------------------------------------------------
    // No way out except the burn
    // ------------------------------------------------------------------

    function test_AdminSurface_IsOnlyTheSwitchAndTheBoundedGuard() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        shareHook.setTaxEnabled(false);

        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        shareHook.setBuybackGuard(1 hours, 50);

        vm.expectRevert(ShareBuybackHook.GuardOutOfRange.selector);
        shareHook.setBuybackGuard(10 minutes - 1, 50);
        vm.expectRevert(ShareBuybackHook.GuardOutOfRange.selector);
        shareHook.setBuybackGuard(6 hours + 1, 50);
        vm.expectRevert(ShareBuybackHook.GuardOutOfRange.selector);
        shareHook.setBuybackGuard(1 hours, 501);
        vm.expectRevert(ShareBuybackHook.GuardOutOfRange.selector);
        shareHook.setBuybackGuard(1 hours, -1);

        shareHook.setBuybackGuard(1 hours, 50);
        assertEq(shareHook.twapWindow(), 1 hours);
        assertEq(shareHook.maxPremiumTicks(), 50);
    }

    function test_Callbacks_OnlyThePoolManager() public {
        vm.expectRevert(BaseV4Hook.NotPoolManager.selector);
        shareHook.unlockCallback(abi.encode(int24(0)));
        vm.expectRevert(BaseV4Hook.NotPoolManager.selector);
        shareHook.beforeSwap(address(0), sharePoolKey, _params(true, 1), "");
        vm.expectRevert(BaseV4Hook.NotPoolManager.selector);
        shareHook.afterSwap(address(0), sharePoolKey, _params(true, 1), BalanceDelta.wrap(0), "");
    }

    function test_Bind_RejectsAPoolThatIsNotShareQuote() public {
        // Same hook, but paired with PEG instead of QUOTE.
        (Currency c0, Currency c1) = address(share) < address(money)
            ? (Currency.wrap(address(share)), Currency.wrap(address(money)))
            : (Currency.wrap(address(money)), Currency.wrap(address(share)));
        PoolKey memory wrong = PoolKey({
            currency0: c0, currency1: c1, fee: 3000, tickSpacing: TICK_SPACING, hooks: IHooks(address(shareHook))
        });
        vm.expectRevert();
        manager.initialize(wrong, TickMath.getSqrtPriceAtTick(0));
    }

    // ------------------------------------------------------------------
    // Accounting holds across arbitrary sequences
    // ------------------------------------------------------------------

    function testFuzz_ShareTaxAccounting_ConservedAcrossAnySequence(
        uint256[10] memory seeds
    ) public {
        uint256 supplyBefore = money.totalSupply();
        _enableTax(); // the peg token's own sell tax runs alongside

        for (uint256 i = 0; i < seeds.length; ++i) {
            uint256 op = seeds[i] % 8;
            uint256 amount = bound(seeds[i] >> 8, 0.01 ether, 5000 ether);
            if (op == 0) {
                try this.shareSwapExternal(alice, true, -int256(amount)) {} catch {}
            } else if (op == 1) {
                try this.shareSwapExternal(alice, true, int256(amount / 4)) {} catch {}
            } else if (op == 2) {
                try this.shareSwapExternal(bob, false, -int256(amount)) {} catch {}
            } else if (op == 3) {
                try this.swapExternal(bob, _buyParams(-int256(amount * 4))) {} catch {}
            } else if (op == 4) {
                try this.swapExternal(alice, _sellParams(-int256(amount * 4))) {} catch {}
            } else if (op == 5) {
                shareHook.executeBuyback();
            } else if (op == 6) {
                skip(20 minutes);
            } else {
                skip(3 hours);
            }
            _assertShareAccounting(supplyBefore);
        }
    }
}

contract ShareBuybackHookMoney0Share0Test is ShareBuybackHookTest {
    function _moneyIsCurrency0() internal pure override returns (bool) {
        return true;
    }

    function _shareIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract ShareBuybackHookMoney0Share1Test is ShareBuybackHookTest {
    function _moneyIsCurrency0() internal pure override returns (bool) {
        return true;
    }

    function _shareIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}

contract ShareBuybackHookMoney1Share0Test is ShareBuybackHookTest {
    function _moneyIsCurrency0() internal pure override returns (bool) {
        return false;
    }

    function _shareIsCurrency0() internal pure override returns (bool) {
        return true;
    }
}

contract ShareBuybackHookMoney1Share1Test is ShareBuybackHookTest {
    function _moneyIsCurrency0() internal pure override returns (bool) {
        return false;
    }

    function _shareIsCurrency0() internal pure override returns (bool) {
        return false;
    }
}
