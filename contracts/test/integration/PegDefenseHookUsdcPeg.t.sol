// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";

import {PegDefenseHook} from "../../src/hooks/PegDefenseHook.sol";
import {PegToken} from "../../src/tokens/PegToken.sol";

/// @notice MONEY (18 decimals) against a 6-decimal stablecoin, through a real local
///         PoolManager, in both token orders. Before the fix the hook read $1.00 as
///         1e-12 or 1e12 and put every sell in the 20% or the 1% tier.
contract PegDefenseHookUsdcPegTest is Test, Deployers {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    PegDefenseHook internal hook;
    PegToken internal money;
    MockERC20 internal usdc;
    PoolKey internal pk;
    bool internal moneyIs0;

    uint160 internal constant HOOK_FLAGS = Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
        | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG;

    function _setUpPool(
        bool usdcSortsFirst
    ) internal {
        deployFreshManagerAndRouters();
        money = new PegToken(address(this));

        // Place the stablecoin below or above MONEY's address to pick the token order.
        address usdcAddr = usdcSortsFirst ? address(uint160(0x1000)) : address(type(uint160).max - 0x1000);
        deployCodeTo("MockERC20.sol:MockERC20", abi.encode("USD Coin", "USDC", uint8(6)), usdcAddr);
        usdc = MockERC20(usdcAddr);

        address hookAddr = address(HOOK_FLAGS | (uint160(0xCAFE) << 144));
        deployCodeTo(
            "PegDefenseHook.sol:PegDefenseHook",
            abi.encode(IPoolManager(address(manager)), address(money), address(this)),
            hookAddr
        );
        hook = PegDefenseHook(hookAddr);

        moneyIs0 = address(money) < usdcAddr;
        assertEq(moneyIs0, !usdcSortsFirst, "token order as intended");
        (Currency c0, Currency c1) = moneyIs0
            ? (Currency.wrap(address(money)), Currency.wrap(usdcAddr))
            : (Currency.wrap(usdcAddr), Currency.wrap(address(money)));
        pk = PoolKey({
            currency0: c0, currency1: c1, fee: LPFeeLibrary.DYNAMIC_FEE_FLAG, tickSpacing: 60, hooks: IHooks(hookAddr)
        });

        // $1.00, worked out independently of the hook: raw price is 1e6/1e18 (MONEY first)
        // or 1e18/1e6 (USDC first), so sqrtPrice is 2^96 / 1e6 or 2^96 * 1e6.
        uint160 pegSqrtPrice = moneyIs0 ? uint160((uint256(1) << 96) / 1e6) : uint160((uint256(1) << 96) * 1e6);
        manager.initialize(pk, pegSqrtPrice);

        money.mint(address(this), 10_000_000 ether);
        usdc.mint(address(this), 10_000_000e6);
        money.approve(address(modifyLiquidityRouter), type(uint256).max);
        usdc.approve(address(modifyLiquidityRouter), type(uint256).max);
        money.approve(address(swapRouter), type(uint256).max);
        usdc.approve(address(swapRouter), type(uint256).max);

        int24 center = (hook.pegTick() / 60) * 60;
        modifyLiquidityRouter.modifyLiquidity(
            pk,
            ModifyLiquidityParams({tickLower: center - 6000, tickUpper: center + 6000, liquidityDelta: 1e16, salt: 0}),
            ""
        );
        hook.setAutoCalculateTax(true);
    }

    function _spotTick() internal view returns (int24 tick) {
        (, tick,,) = manager.getSlot0(pk.toId());
    }

    function _sellExactIn(
        uint256 amount,
        uint160 limit
    ) internal returns (uint256 burned) {
        uint256 s0 = money.totalSupply();
        swapRouter.swap(
            pk,
            SwapParams({zeroForOne: moneyIs0, amountSpecified: -int256(amount), sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        burned = s0 - money.totalSupply();
    }

    function _noLimit() internal view returns (uint160) {
        return moneyIs0 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT;
    }

    function _checkPegReadsAsOneDollar() internal {
        assertApproxEqRel(hook.pegPriceFromTick(_spotTick()), 1e18, 2e14, "$1.00 reads as 1.00");
        uint256 burned = _sellExactIn(100 ether, _noLimit());
        assertEq(burned, 15 ether, "a sell at peg pays the peg tier (15%)");
    }

    function test_UsdcPeg_MoneyFirst() public {
        _setUpPool(false);
        assertLt(hook.pegTick(), -276_000, "peg tick derived for MONEY/USDC");
        _checkPegReadsAsOneDollar();
    }

    function test_UsdcPeg_UsdcFirst() public {
        _setUpPool(true);
        assertGt(hook.pegTick(), 276_000, "peg tick derived for USDC/MONEY");
        _checkPegReadsAsOneDollar();
    }

    /// @notice A price crash inside one block doesn't move the tax tier; the TWAP does.
    function test_TierFollowsTwapNotSameBlockSpot() public {
        _setUpPool(false);
        vm.warp(block.timestamp + 2 hours);
        _sellExactIn(1 ether, _noLimit()); // records two hours at the peg

        // Crash MONEY to about $0.67 in this block.
        // Tax off for the crash itself: its 15% slice would exceed the MONEY the PoolManager
        // holds mid-swap (the hook takes before the seller settles).
        int24 crashTick = hook.pegTick() - 4000;
        hook.setAutoCalculateTax(false);
        hook.setMaxSellImpactBps(0); // the crash is bigger than the 5% sell cap
        _sellExactIn(5_000_000 ether, TickMath.getSqrtPriceAtTick(crashTick));
        hook.setMaxSellImpactBps(500);
        hook.setAutoCalculateTax(true);
        assertLt(hook.pegPriceFromTick(_spotTick()), 0.7e18, "spot is far below the peg");

        // Same block: the tier still reads the peg-level TWAP.
        assertApproxEqAbs(int256(hook.twapTick()), int256(hook.pegTick()), 10, "TWAP still at peg");
        uint256 burned = _sellExactIn(100 ether, _noLimit());
        assertEq(burned, 15 ether, "tier unchanged within the block");

        // After time passes at the low price, the TWAP and the tier catch up.
        vm.warp(block.timestamp + 3 hours);
        _sellExactIn(1 ether, _noLimit());
        vm.warp(block.timestamp + 1 hours);
        uint256 later = _sellExactIn(100 ether, _noLimit());
        assertGt(later, 15 ether, "tier rises once the low price persists");
    }

    // ------------------------------------------------------------------
    // Sell cap: a sell may move MONEY's price at most maxSellImpactBps (5%)
    // ------------------------------------------------------------------

    function _sellToImpact(
        int256 ticksDown
    ) internal returns (uint256) {
        return _sellExactIn(5_000_000 ether, TickMath.getSqrtPriceAtTick(_spotTick() - int24(ticksDown)));
    }

    function test_SellCap_DefaultIsFivePercent() public {
        _setUpPool(false);
        assertEq(hook.maxSellImpactBps(), 500);
        assertEq(hook.maxSellImpactTicks(), 512, "1.0001^-512 is the deepest drop at or under 5%");
    }

    function test_SellCap_AllowsSellUnderCap() public {
        _setUpPool(false);
        hook.setAutoCalculateTax(false);
        _sellToImpact(500); // ~4.9%
        assertLt(hook.pegPriceFromTick(_spotTick()), 0.96e18);
    }

    /// @dev Bare swap with no reads around it, so vm.expectRevert lands on the swap itself.
    function _rawSell(
        uint256 amount,
        uint160 limit
    ) internal {
        swapRouter.swap(
            pk,
            SwapParams({zeroForOne: moneyIs0, amountSpecified: -int256(amount), sqrtPriceLimitX96: limit}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function test_SellCap_RevertsSellOverCap() public {
        _setUpPool(false);
        hook.setAutoCalculateTax(false);
        uint160 limit = TickMath.getSqrtPriceAtTick(_spotTick() - 600); // ~5.8%
        vm.expectRevert(); // PoolManager wraps the hook's SellTooLarge(500)
        _rawSell(5_000_000 ether, limit);
    }

    function test_SellCap_FollowsDepth() public {
        _setUpPool(false);
        hook.setAutoCalculateTax(false);
        int24 center = (hook.pegTick() / 60) * 60;
        // 100 MONEY moves this pool well past 5% once liquidity is thin...
        modifyLiquidityRouter.modifyLiquidity(
            pk,
            ModifyLiquidityParams({
                tickLower: center - 6000, tickUpper: center + 6000, liquidityDelta: -9.99e15, salt: 0
            }),
            ""
        );
        uint160 noLimit = _noLimit();
        vm.expectRevert();
        _rawSell(100 ether, noLimit);
        // ...and fits again once the pool is deep.
        modifyLiquidityRouter.modifyLiquidity(
            pk,
            ModifyLiquidityParams({tickLower: center - 6000, tickUpper: center + 6000, liquidityDelta: 1e18, salt: 0}),
            ""
        );
        _sellExactIn(100 ether, _noLimit());
    }

    function test_SellCap_SkipsBuysAndExcludedSenders() public {
        _setUpPool(false);
        hook.setAutoCalculateTax(false);
        // A buy that moves the price 6% up is fine.
        swapRouter.swap(
            pk,
            SwapParams({
                zeroForOne: !moneyIs0,
                amountSpecified: -int256(5_000_000e6),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(_spotTick() + 600)
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        // A protocol contract (here the swap router) may sell past the cap.
        hook.setExcludedAddress(address(swapRouter), true);
        _sellToImpact(1200);
    }

    function test_SetMaxSellImpact_Bounded() public {
        _setUpPool(false);
        vm.expectRevert(PegDefenseHook.SellImpactOutOfRange.selector);
        hook.setMaxSellImpactBps(10);
        vm.expectRevert(PegDefenseHook.SellImpactOutOfRange.selector);
        hook.setMaxSellImpactBps(6000);
        hook.setMaxSellImpactBps(0);
        assertEq(hook.maxSellImpactTicks(), 0, "0 turns the cap off");
    }

    function test_SetTwapWindow_Bounded() public {
        _setUpPool(false);
        vm.expectRevert(PegDefenseHook.TwapWindowOutOfRange.selector);
        hook.setTwapWindow(1 minutes);
        vm.expectRevert(PegDefenseHook.TwapWindowOutOfRange.selector);
        hook.setTwapWindow(2 days);
        hook.setTwapWindow(6 hours);
        assertEq(hook.twapWindow(), 6 hours);
    }
}
