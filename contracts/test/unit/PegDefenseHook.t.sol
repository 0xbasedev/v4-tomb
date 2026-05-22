// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";

import {PegDefenseHook} from "../../src/hooks/PegDefenseHook.sol";
import {BaseV4Hook} from "../../src/hooks/base/BaseV4Hook.sol";
import {OldMoney} from "../../src/tokens/OldMoney.sol";
import {Trustees} from "../../src/governance/Trustees.sol";

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams} from "v4-core/src/types/PoolOperation.sol";

/// @notice Minimal pool manager stub: implements only `extsload(bytes32)` so the hook can
///         read Slot0 via V4's StateLibrary. `setTick` packs the tick into the slot0 layout.
contract MockPoolManager {
    bytes32 public slot0Data;

    function setTick(
        int24 tick
    ) external {
        // Slot0 layout: bottom 160 bits = sqrtPriceX96, next 24 = tick.
        slot0Data = bytes32(uint256(uint24(tick)) << 160);
    }

    function extsload(
        bytes32
    ) external view returns (bytes32) {
        return slot0Data;
    }
}

contract PegDefenseHookTest is BaseTest {
    using PoolIdLibrary for PoolKey;

    PegDefenseHook internal hook;
    MockPoolManager internal pm;
    OldMoney internal money;
    address internal weth = makeAddr("weth");
    PoolKey internal poolKey;

    address internal hookAddr;

    function setUp() public override {
        super.setUp();
        vm.label(weth, "weth");

        vm.warp(1_700_000_000);

        pm = new MockPoolManager();

        vm.prank(owner);
        money = new OldMoney();

        // Compute the only address with the right permission bits we need:
        // AFTER_INITIALIZE | BEFORE_SWAP.
        hookAddr = address(uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG));

        deployCodeTo(
            "PegDefenseHook.sol:PegDefenseHook", abi.encode(IPoolManager(address(pm)), address(money)), hookAddr
        );
        hook = PegDefenseHook(hookAddr);

        // Sort the two tokens into V4 currency order.
        (Currency c0, Currency c1) = address(money) < weth
            ? (Currency.wrap(address(money)), Currency.wrap(weth))
            : (Currency.wrap(weth), Currency.wrap(address(money)));

        poolKey = PoolKey({
            currency0: c0, currency1: c1, fee: LPFeeLibrary.DYNAMIC_FEE_FLAG, tickSpacing: 60, hooks: IHooks(hookAddr)
        });

        // The hook's Trustees defaulted to the test contract (msg.sender during deployCodeTo).
        // Rotate to the dedicated `trustees` actor for clearer test semantics.
        hook.transferTrustees(trustees);
    }

    // ---------------------------------------------------------------------
    // Constructor + hook permissions
    // ---------------------------------------------------------------------

    function test_Constructor_StoresImmutables() public view {
        assertEq(address(hook.poolManager()), address(pm));
        assertEq(hook.money(), address(money));
    }

    function test_HookPermissions_OnlyAfterInitAndBeforeSwap() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.afterInitialize);
        assertTrue(p.beforeSwap);
        assertFalse(p.beforeInitialize);
        assertFalse(p.afterSwap);
        assertFalse(p.beforeAddLiquidity);
        assertFalse(p.afterAddLiquidity);
        assertFalse(p.beforeRemoveLiquidity);
        assertFalse(p.afterRemoveLiquidity);
        assertFalse(p.beforeDonate);
        assertFalse(p.afterDonate);
        assertFalse(p.beforeSwapReturnDelta);
        assertFalse(p.afterSwapReturnDelta);
        assertFalse(p.afterAddLiquidityReturnDelta);
        assertFalse(p.afterRemoveLiquidityReturnDelta);
    }

    function test_DefaultRevertingHooks_AreUncallable() public {
        vm.prank(address(pm));
        vm.expectRevert(BaseV4Hook.HookNotImplemented.selector);
        hook.beforeInitialize(address(0), poolKey, 0);

        vm.prank(address(pm));
        vm.expectRevert(BaseV4Hook.HookNotImplemented.selector);
        hook.beforeDonate(address(0), poolKey, 0, 0, "");
    }

    // ---------------------------------------------------------------------
    // afterInitialize
    // ---------------------------------------------------------------------

    function test_AfterInitialize_OnlyPoolManager() public {
        vm.prank(stranger);
        vm.expectRevert(BaseV4Hook.NotPoolManager.selector);
        hook.afterInitialize(address(0), poolKey, 0, 0);
    }

    function test_AfterInitialize_RecordsState() public {
        vm.prank(address(pm));
        hook.afterInitialize(address(0), poolKey, 0, 123);

        assertTrue(hook.bound());
        assertEq(hook.lastTick(), 123);
        assertEq(hook.lastObservationTimestamp(), uint32(block.timestamp));
        assertEq(hook.tickCumulative(), 0);
        bytes32 expectedId = PoolId.unwrap(poolKey.toId());
        assertEq(PoolId.unwrap(hook.poolId()), expectedId);
    }

    function test_AfterInitialize_DetectsMoneyOrientation() public {
        vm.prank(address(pm));
        hook.afterInitialize(address(0), poolKey, 0, 0);
        // MONEY is currency0 iff its address is the lower of the two.
        bool expectedIsCurrency0 = address(money) < weth;
        assertEq(hook.moneyIsCurrency0(), expectedIsCurrency0);
    }

    function test_AfterInitialize_OneShot() public {
        vm.prank(address(pm));
        hook.afterInitialize(address(0), poolKey, 0, 0);

        vm.prank(address(pm));
        vm.expectRevert(PegDefenseHook.AlreadyBound.selector);
        hook.afterInitialize(address(0), poolKey, 0, 0);
    }

    function test_AfterInitialize_RejectsPoolMissingMoney() public {
        address otherA = makeAddr("otherA");
        address otherB = makeAddr("otherB");
        (Currency c0, Currency c1) = otherA < otherB
            ? (Currency.wrap(otherA), Currency.wrap(otherB))
            : (Currency.wrap(otherB), Currency.wrap(otherA));
        PoolKey memory badKey = PoolKey({
            currency0: c0, currency1: c1, fee: LPFeeLibrary.DYNAMIC_FEE_FLAG, tickSpacing: 60, hooks: IHooks(hookAddr)
        });

        vm.prank(address(pm));
        vm.expectRevert(PegDefenseHook.PoolMissingMoney.selector);
        hook.afterInitialize(address(0), badKey, 0, 0);
    }

    // ---------------------------------------------------------------------
    // beforeSwap — observation + fee
    // ---------------------------------------------------------------------

    function test_BeforeSwap_OnlyPoolManager() public {
        _bind(0);
        vm.prank(stranger);
        vm.expectRevert(BaseV4Hook.NotPoolManager.selector);
        hook.beforeSwap(address(0), poolKey, _emptySwap(), "");
    }

    function test_BeforeSwap_RequiresBoundPool() public {
        // Not bound yet → revert.
        vm.prank(address(pm));
        vm.expectRevert(PegDefenseHook.UnknownPool.selector);
        hook.beforeSwap(address(0), poolKey, _emptySwap(), "");
    }

    function test_BeforeSwap_AccumulatesObservation() public {
        _bind(0); // last tick = 0, lastObsTs = block.timestamp

        // Advance 1000 seconds at constant tick 0 — cumulative stays 0.
        vm.warp(block.timestamp + 1000);
        pm.setTick(0);
        vm.prank(address(pm));
        hook.beforeSwap(address(0), poolKey, _emptySwap(), "");
        assertEq(hook.tickCumulative(), 0);

        // Now the pool's tick is 100 (simulating post-swap state). Advance 500 seconds.
        vm.warp(block.timestamp + 500);
        pm.setTick(100);
        vm.prank(address(pm));
        hook.beforeSwap(address(0), poolKey, _emptySwap(), "");
        // Between the two beforeSwap calls, lastTick was still 0 (set in first call),
        // so cumulative gained 0 * 500 = 0.
        assertEq(hook.tickCumulative(), 0);
        assertEq(hook.lastTick(), 100);

        // Advance another 500 at tick 100 → cumulative gains 100*500 = 50_000.
        vm.warp(block.timestamp + 500);
        pm.setTick(100);
        vm.prank(address(pm));
        hook.beforeSwap(address(0), poolKey, _emptySwap(), "");
        assertEq(hook.tickCumulative(), 50_000);
    }

    function test_BeforeSwap_ReturnsBaseFeeNearPeg() public {
        _bind(0);
        pm.setTick(0); // exactly at peg
        (, BeforeSwapDelta delta, uint24 feeOverride) = _beforeSwapCall();

        assertEq(BeforeSwapDelta.unwrap(delta), 0);
        // baseFee = 3000, ORed with OVERRIDE_FEE_FLAG.
        assertEq(feeOverride, uint24(3000) | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function test_BeforeSwap_ReturnsExpansionFeeAbovePeg() public {
        _bind(0);
        // 200 ticks above peg, MONEY is whichever side is currency0/1.
        // If money is currency0, currentTick > pegTick == "MONEY appreciating" → expansion.
        // If money is currency1, we need currentTick LESS than peg to be expansion. Flip sign.
        int24 t = hook.moneyIsCurrency0() ? int24(200) : int24(-200);
        pm.setTick(t);

        (,, uint24 feeOverride) = _beforeSwapCall();
        assertEq(feeOverride, uint24(1000) | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function test_BeforeSwap_ReturnsContractionFeeBelowPeg() public {
        _bind(0);
        int24 t = hook.moneyIsCurrency0() ? int24(-150) : int24(150);
        pm.setTick(t);

        (,, uint24 feeOverride) = _beforeSwapCall();
        assertEq(feeOverride, uint24(10_000) | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    function test_BeforeSwap_ReturnsDeepContractionFeeFarBelowPeg() public {
        _bind(0);
        int24 t = hook.moneyIsCurrency0() ? int24(-500) : int24(500);
        pm.setTick(t);

        (,, uint24 feeOverride) = _beforeSwapCall();
        assertEq(feeOverride, uint24(30_000) | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    // ---------------------------------------------------------------------
    // IPriceSource — getCurrentTickCumulative
    // ---------------------------------------------------------------------

    function test_GetCurrentTickCumulative_ZeroBeforeBind() public view {
        (int56 cum, uint32 ts) = hook.getCurrentTickCumulative();
        assertEq(cum, 0);
        assertEq(ts, uint32(block.timestamp));
    }

    function test_GetCurrentTickCumulative_ProjectsAtLastTick() public {
        _bind(50); // tick=50 at bind
        // No swaps yet. After 600 seconds, projection = 50 * 600 = 30_000.
        vm.warp(block.timestamp + 600);

        (int56 cum, uint32 ts) = hook.getCurrentTickCumulative();
        assertEq(cum, 30_000);
        assertEq(ts, uint32(block.timestamp));
    }

    // ---------------------------------------------------------------------
    // Trustees governance
    // ---------------------------------------------------------------------

    function test_SetPegTick_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        hook.setPegTick(123);
    }

    function test_SetPegTick_Updates() public {
        vm.prank(trustees);
        hook.setPegTick(50);
        assertEq(hook.pegTick(), 50);
    }

    function test_SetBandTicks_RejectsZero() public {
        vm.prank(trustees);
        vm.expectRevert(PegDefenseHook.BandTicksMustBePositive.selector);
        hook.setBandTicks(0);

        vm.prank(trustees);
        vm.expectRevert(PegDefenseHook.BandTicksMustBePositive.selector);
        hook.setBandTicks(-5);
    }

    function test_SetBandTicks_Updates() public {
        vm.prank(trustees);
        hook.setBandTicks(50);
        assertEq(hook.bandTicks(), 50);
    }

    function test_SetFees_RejectsTooHigh() public {
        vm.prank(trustees);
        vm.expectRevert(PegDefenseHook.FeeTooHigh.selector);
        hook.setFees(1, 2, 3, LPFeeLibrary.MAX_LP_FEE + 1);
    }

    function test_SetFees_UpdatesAllTiers() public {
        vm.prank(trustees);
        hook.setFees(500, 2000, 8000, 20_000);
        assertEq(hook.expansionFee(), 500);
        assertEq(hook.baseFee(), 2000);
        assertEq(hook.contractionFee(), 8000);
        assertEq(hook.deepContractionFee(), 20_000);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _bind(
        int24 initialTick
    ) internal {
        vm.prank(address(pm));
        hook.afterInitialize(address(0), poolKey, 0, initialTick);
    }

    function _emptySwap() internal pure returns (SwapParams memory) {
        return SwapParams({zeroForOne: true, amountSpecified: 0, sqrtPriceLimitX96: 0});
    }

    function _beforeSwapCall() internal returns (bytes4 sel, BeforeSwapDelta delta, uint24 fee) {
        vm.prank(address(pm));
        (sel, delta, fee) = hook.beforeSwap(address(0), poolKey, _emptySwap(), "");
    }
}
