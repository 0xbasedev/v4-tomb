// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams, SwapParams} from "v4-core/src/types/PoolOperation.sol";

import {PegDefenseHook} from "../../src/hooks/PegDefenseHook.sol";
import {PegToken} from "../../src/tokens/PegToken.sol";

/// @notice Swaps through a real local PoolManager to prove the sell tax lands the same way
///         whether the seller fixes the MONEY input (exact-input) or the output (exact-output).
///         Before the fix, exact-output sells sized the tax from the output amount, so a
///         seller naming a USDC (6-decimal) output paid ~10^12 less tax.
contract PegDefenseHookExactOutputTest is Test, Deployers {
    PegDefenseHook internal hook;
    PegToken internal money;
    MockERC20 internal other;
    PoolKey internal pk;
    bool internal moneyIs0;

    uint256 internal constant RATE = 1500; // tier at tick 0 (price ~1.00)

    function setUp() public {
        deployFreshManagerAndRouters();

        money = new PegToken(address(this));
        other = new MockERC20("Other", "OTH", 18);

        address hookAddr = address(
            uint160(
                Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                    | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
            ) | (uint160(0xBEEF) << 144)
        );
        deployCodeTo(
            "PegDefenseHook.sol:PegDefenseHook",
            abi.encode(IPoolManager(address(manager)), address(money), address(this)),
            hookAddr
        );
        hook = PegDefenseHook(hookAddr);

        moneyIs0 = address(money) < address(other);
        (Currency c0, Currency c1) = moneyIs0
            ? (Currency.wrap(address(money)), Currency.wrap(address(other)))
            : (Currency.wrap(address(other)), Currency.wrap(address(money)));
        pk = PoolKey({
            currency0: c0, currency1: c1, fee: LPFeeLibrary.DYNAMIC_FEE_FLAG, tickSpacing: 60, hooks: IHooks(hookAddr)
        });
        manager.initialize(pk, SQRT_PRICE_1_1);

        money.mint(address(this), 1_000_000 ether);
        other.mint(address(this), 1_000_000 ether);
        money.approve(address(modifyLiquidityRouter), type(uint256).max);
        other.approve(address(modifyLiquidityRouter), type(uint256).max);
        money.approve(address(swapRouter), type(uint256).max);
        other.approve(address(swapRouter), type(uint256).max);

        modifyLiquidityRouter.modifyLiquidity(
            pk, ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1_000_000 ether, salt: 0}), ""
        );

        hook.setAutoCalculateTax(true);
    }

    function _sell(
        int256 amountSpecified
    ) internal returns (uint256 moneyPaid, uint256 otherGot, uint256 burned) {
        uint256 m0 = money.balanceOf(address(this));
        uint256 o0 = other.balanceOf(address(this));
        uint256 s0 = money.totalSupply();
        swapRouter.swap(
            pk,
            SwapParams({
                zeroForOne: moneyIs0,
                amountSpecified: amountSpecified,
                sqrtPriceLimitX96: moneyIs0 ? MIN_PRICE_LIMIT : MAX_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        moneyPaid = m0 - money.balanceOf(address(this));
        otherGot = other.balanceOf(address(this)) - o0;
        burned = s0 - money.totalSupply();
    }

    function test_ExactInputSell_TaxedThroughRealPool() public {
        (uint256 paid,, uint256 burned) = _sell(-1000 ether);
        assertEq(paid, 1000 ether, "seller pays the exact input");
        assertEq(burned, 150 ether, "15% of the input burned");
    }

    /// @notice The bypass case. Seller asks for an exact output; tax must be 15% of the
    ///         MONEY they actually pay, not 15% of the output amount.
    function test_ExactOutputSell_TaxedOnMoneyPaid() public {
        (uint256 paid, uint256 got, uint256 burned) = _sell(int256(500 ether));
        assertEq(got, 500 ether, "seller receives the exact output");
        assertGt(burned, 0, "tax charged");
        assertApproxEqAbs(burned * 10_000 / paid, RATE, 1, "tax is 15% of all MONEY paid");
        // Pool got paid - burned; tax is grossed up on that.
        assertApproxEqAbs(burned, (paid - burned) * RATE / (10_000 - RATE), 1);
    }

    /// @notice A tiny output (like 1,000 USDC written in 6 decimals) no longer shrinks the tax.
    function test_ExactOutputSell_SmallOutputStillFullRate() public {
        (uint256 paid,, uint256 burned) = _sell(int256(1000e6));
        assertApproxEqAbs(burned * 10_000 / paid, RATE, 1, "rate holds on tiny outputs");
    }

    function test_ExactOutputBuy_NotTaxed() public {
        uint256 s0 = money.totalSupply();
        swapRouter.swap(
            pk,
            SwapParams({
                zeroForOne: !moneyIs0,
                amountSpecified: int256(100 ether),
                sqrtPriceLimitX96: moneyIs0 ? MAX_PRICE_LIMIT : MIN_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        assertEq(money.totalSupply(), s0, "buys never burn");
    }
}
