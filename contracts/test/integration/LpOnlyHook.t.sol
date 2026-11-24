// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {HookPoolFixture, FixtureWeth} from "../utils/HookPoolFixture.t.sol";

import {LpOnlyHook, LpOnlyHookPermissions} from "../../src/hooks/LpOnlyHook.sol";
import {BaseV4Hook} from "../../src/hooks/base/BaseV4Hook.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";

/**
 * @title LpOnlyHookTest
 * @notice The peg/share staking pool against a real v4-core PoolManager: liquidity moves
 *         freely, no swap of any kind goes through, and the ratio never changes.
 */
contract LpOnlyHookTest is HookPoolFixture {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    FixtureWeth internal share;
    LpOnlyHook internal lpHook;
    PoolKey internal pairKey;

    function _moneyIsCurrency0() internal pure override returns (bool) {
        return true;
    }

    function setUp() public override {
        super.setUp();
        address shareAddr = address(uint160(address(weth)) + 2);
        deployCodeTo("HookPoolFixture.t.sol:FixtureWeth", shareAddr);
        share = FixtureWeth(shareAddr);

        address at = address(LpOnlyHookPermissions.FLAGS | (uint160(0xF00D) << 144));
        deployCodeTo(
            "LpOnlyHook.sol:LpOnlyHook",
            abi.encode(IPoolManager(address(manager)), address(money), address(share), address(this)),
            at
        );
        lpHook = LpOnlyHook(at);
        pairKey = _pairKey(60);

        address[3] memory actors = [address(this), alice, bob];
        for (uint256 i = 0; i < actors.length; ++i) {
            share.mint(actors[i], ACTOR_BALANCE);
            vm.startPrank(actors[i]);
            share.approve(address(swapRouter), type(uint256).max);
            share.approve(address(liquidityRouter), type(uint256).max);
            vm.stopPrank();
        }
    }

    function _pairKey(
        int24 spacing
    ) internal view returns (PoolKey memory) {
        (Currency c0, Currency c1) = address(money) < address(share)
            ? (Currency.wrap(address(money)), Currency.wrap(address(share)))
            : (Currency.wrap(address(share)), Currency.wrap(address(money)));
        return PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: spacing, hooks: IHooks(address(lpHook))});
    }

    function _open() internal {
        manager.initialize(pairKey, TickMath.getSqrtPriceAtTick(0));
    }

    function _modify(
        address who,
        int256 liquidity
    ) internal {
        vm.prank(who);
        liquidityRouter.modifyLiquidity(
            pairKey,
            ModifyLiquidityParams({
                tickLower: FULL_RANGE_LOWER, tickUpper: FULL_RANGE_UPPER, liquidityDelta: liquidity, salt: bytes32(0)
            }),
            ""
        );
    }

    // ------------------------------------------------------------------
    // Who may open the pool, and which pool
    // ------------------------------------------------------------------

    function test_Permissions_MatchTheAddress() public view {
        assertEq(lpHook.PERMISSION_FLAGS(), 0x2080);
        assertEq(uint160(address(lpHook)) & 0x3FFF, 0x2080);
        Hooks.Permissions memory p = lpHook.getHookPermissions();
        assertTrue(p.beforeInitialize);
        assertTrue(p.beforeSwap);
        assertFalse(p.beforeAddLiquidity);
        assertFalse(p.beforeRemoveLiquidity);
        assertFalse(p.beforeSwapReturnDelta);
    }

    function test_OnlyTheInitializerCanOpenThePool() public {
        vm.prank(stranger);
        vm.expectRevert();
        manager.initialize(pairKey, TickMath.getSqrtPriceAtTick(6000));
        assertFalse(lpHook.bound(), "a stranger cannot fix the ratio");

        _open();
        assertTrue(lpHook.bound());
    }

    function test_OnlyOnePoolCanEverUseTheHook() public {
        _open();
        vm.expectRevert();
        manager.initialize(_pairKey(10), TickMath.getSqrtPriceAtTick(0));
    }

    function test_RejectsAPoolOfOtherTokens() public {
        (Currency c0, Currency c1) = address(money) < address(weth)
            ? (Currency.wrap(address(money)), Currency.wrap(address(weth)))
            : (Currency.wrap(address(weth)), Currency.wrap(address(money)));
        PoolKey memory wrong =
            PoolKey({currency0: c0, currency1: c1, fee: 0, tickSpacing: 60, hooks: IHooks(address(lpHook))});
        vm.expectRevert();
        manager.initialize(wrong, TickMath.getSqrtPriceAtTick(0));
    }

    function test_Callbacks_OnlyThePoolManager() public {
        vm.expectRevert(BaseV4Hook.NotPoolManager.selector);
        lpHook.beforeInitialize(address(this), pairKey, 0);
        vm.expectRevert(BaseV4Hook.NotPoolManager.selector);
        lpHook.beforeSwap(address(0), pairKey, _params(true, -1), "");
    }

    // ------------------------------------------------------------------
    // Untradeable
    // ------------------------------------------------------------------

    function test_EverySwapReverts_InBothDirectionsAndBothModes() public {
        _open();
        _modify(address(this), 10_000 ether);

        int256[2] memory amounts = [int256(-1 ether), int256(1 ether)];
        for (uint256 d = 0; d < 2; ++d) {
            for (uint256 m = 0; m < 2; ++m) {
                vm.prank(alice);
                vm.expectRevert();
                swapRouter.swap(pairKey, _params(d == 0, amounts[m]), PoolSwapTest.TestSettings(false, false), "");
            }
        }
    }

    function test_SwapRevertsWithSwapsDisabled_FromThePoolManager() public {
        vm.prank(address(manager));
        vm.expectRevert(LpOnlyHook.SwapsDisabled.selector);
        lpHook.beforeSwap(alice, pairKey, _params(true, -1 ether), "");
    }

    function test_BatchRouterCannotTradeItEither() public {
        _open();
        _modify(address(this), 10_000 ether);
        PoolKey[] memory keys = new PoolKey[](1);
        SwapParams[] memory swaps = new SwapParams[](1);
        keys[0] = pairKey;
        swaps[0] = _params(true, -1 ether);
        money.approve(address(batchRouter), type(uint256).max);
        vm.expectRevert();
        batchRouter.swapBatch(keys, swaps);
    }

    // ------------------------------------------------------------------
    // Liquidity still works, at a ratio that never moves
    // ------------------------------------------------------------------

    function test_AnyoneCanAddAndRemove_AndGetsBackExactlyWhatTheyPutIn() public {
        _open();
        _modify(address(this), 10_000 ether);
        (uint160 priceBefore,,,) = IPoolManager(address(manager)).getSlot0(pairKey.toId());

        uint256 moneyBefore = money.balanceOf(alice);
        uint256 shareBefore = share.balanceOf(alice);

        _modify(alice, 500 ether);
        uint256 moneyIn = moneyBefore - money.balanceOf(alice);
        uint256 shareIn = shareBefore - share.balanceOf(alice);
        assertGt(moneyIn, 0);
        assertApproxEqAbs(moneyIn, shareIn, 2, "deposit is at the fixed opening ratio");

        // Other people come and go in between; with no trading it changes nothing.
        _modify(bob, 2000 ether);
        skip(30 days);
        _modify(bob, -2000 ether);

        _modify(alice, -500 ether);
        assertApproxEqAbs(money.balanceOf(alice), moneyBefore, 2, "all MONEY returned (rounding only)");
        assertApproxEqAbs(share.balanceOf(alice), shareBefore, 2, "all SHARE returned (rounding only)");

        (uint160 priceAfter,,,) = IPoolManager(address(manager)).getSlot0(pairKey.toId());
        assertEq(priceAfter, priceBefore, "the ratio never moves");
    }
}
