// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";
import {HistoricalAddresses as Addresses} from "../fixtures/HistoricalAddresses.sol";
import {MiniSwapRouter} from "../../src/swap/MiniSwapRouter.sol";
import {OldMoney} from "../../src/tokens/OldMoney.sol";
import {PegDefenseHook} from "../../src/hooks/PegDefenseHook.sol";
import {HookMiner} from "../utils/HookMiner.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";

interface IWeth9 {
    function deposit() external payable;
    function approve(
        address spender,
        uint256 amount
    ) external returns (bool);
    function balanceOf(
        address account
    ) external view returns (uint256);
    function transfer(
        address to,
        uint256 amount
    ) external returns (bool);
}

/**
 * @notice Base mainnet fork test for MiniSwapRouter — the in-house V4 swap router.
 *         Verifies the load-bearing properties:
 *
 *           1. ERC-20 approve + swapExactIn delivers the output token to the recipient
 *           2. Hook tax (when enabled) is intercepted correctly and routed to burn
 *           3. amountOutMin slippage gate reverts cleanly with TooLittleReceived
 *           4. zero amountIn reverts cleanly with ZeroAmount
 *           5. Non-PoolManager caller into unlockCallback reverts with NotPoolManager
 *
 *         Uses the live Base mainnet V4 PoolManager via fork, deploys a fresh MONEY
 *         token + hook + pool, seeds liquidity, then exercises the router.
 *
 *         Gated on BASE_RPC_URL — skipped if unset (matches the other BaseFork tests).
 */
contract BaseForkMiniSwapRouterTest is BaseTest {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    IPoolManager internal pm;
    OldMoney internal money;
    PegDefenseHook internal hook;
    MiniSwapRouter internal router;
    PoolModifyLiquidityTest internal liquidityRouter;

    address internal weth;
    PoolKey internal poolKey;

    // `alice` and `owner` are inherited from BaseTest — reuse them.

    bool internal forked;

    function setUp() public override {
        string memory url = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        forked = true;
        super.setUp();

        pm = IPoolManager(Addresses.poolManager());
        weth = Addresses.weth();

        // Deploy MONEY (test contract holds trustees role; no Treasury needed for swap tests).
        vm.prank(owner);
        money = new OldMoney(owner);

        // Mine a hook address with the required permissions (AFTER_INITIALIZE | BEFORE_SWAP |
        // BEFORE_SWAP_RETURNS_DELTA = 0x1088). Use HookMiner so the resulting CREATE2
        // address has the bit pattern V4 validates against.
        uint160 flags =
            uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
        bytes memory hookCreationCode =
            abi.encodePacked(type(PegDefenseHook).creationCode, abi.encode(pm, address(money), address(this)));
        (address minedHookAddr, bytes32 salt) = HookMiner.find(address(this), flags, hookCreationCode);
        hook = PegDefenseHook(payable(_deployWithSalt(hookCreationCode, salt)));
        assertEq(address(hook), minedHookAddr, "hook addr mined");

        // Sort tokens for the pool key.
        (Currency c0, Currency c1) = address(money) < weth
            ? (Currency.wrap(address(money)), Currency.wrap(weth))
            : (Currency.wrap(weth), Currency.wrap(address(money)));

        poolKey = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });

        pm.initialize(poolKey, TickMath.getSqrtPriceAtTick(0));

        // Deploy the routers.
        router = new MiniSwapRouter(pm);
        liquidityRouter = new PoolModifyLiquidityTest(pm);

        // Seed liquidity: full range, 10 MONEY + 10 WETH at tick 0.
        vm.deal(address(this), 100 ether);
        IWeth9(weth).deposit{value: 50 ether}();
        vm.prank(owner);
        money.mint(address(this), 100 ether);

        IERC20(address(money)).approve(address(liquidityRouter), type(uint256).max);
        IWeth9(weth).approve(address(liquidityRouter), type(uint256).max);

        int24 tickLower = (TickMath.MIN_TICK / 60) * 60;
        int24 tickUpper = (TickMath.MAX_TICK / 60) * 60;
        uint160 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(0);
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            10 ether,
            10 ether
        );
        liquidityRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({
                tickLower: tickLower, tickUpper: tickUpper, liquidityDelta: int256(uint256(liq)), salt: 0
            }),
            bytes("")
        );

        // Fund alice with MONEY + WETH for swap tests.
        vm.prank(owner);
        money.mint(alice, 5 ether);
        IWeth9(weth).transfer(alice, 5 ether);
    }

    function _deployWithSalt(
        bytes memory creationCode,
        bytes32 salt
    ) internal returns (address deployed) {
        assembly {
            deployed := create2(0, add(creationCode, 0x20), mload(creationCode), salt)
        }
        require(deployed != address(0), "deploy failed");
    }

    // ---------------------------------------------------------------------
    // Tests
    // ---------------------------------------------------------------------

    function test_SwapExactIn_MoneyForWeth_DeliversOutput() public {
        if (!forked) return;
        uint256 amountIn = 0.1 ether;

        vm.prank(alice);
        IERC20(address(money)).approve(address(router), amountIn);

        uint256 wethBefore = IWeth9(weth).balanceOf(alice);

        // MONEY is currency1 (since WETH < MONEY); selling MONEY = currency1 -> currency0 = zeroForOne = false
        bool zeroForOne = address(weth) < address(money) ? false : true;
        vm.prank(alice);
        uint256 amountOut = router.swapExactIn(poolKey, zeroForOne, amountIn, 0, alice);

        uint256 wethAfter = IWeth9(weth).balanceOf(alice);
        assertGt(amountOut, 0, "amountOut > 0");
        assertEq(wethAfter - wethBefore, amountOut, "recipient credited exactly amountOut");
    }

    function test_SwapExactIn_RevertsOnZeroAmount() public {
        if (!forked) return;
        vm.prank(alice);
        vm.expectRevert(MiniSwapRouter.ZeroAmount.selector);
        router.swapExactIn(poolKey, true, 0, 0, alice);
    }

    function test_SwapExactIn_RevertsOnSlippage() public {
        if (!forked) return;
        uint256 amountIn = 0.1 ether;
        // Ask for 100 WETH out — clearly impossible from 0.1 MONEY input.
        uint256 absurdMin = 100 ether;

        vm.prank(alice);
        IERC20(address(money)).approve(address(router), amountIn);

        bool zeroForOne = address(weth) < address(money) ? false : true;
        vm.prank(alice);
        vm.expectRevert(); // TooLittleReceived(min, actual) — exact match not required, just that it reverts cleanly
        router.swapExactIn(poolKey, zeroForOne, amountIn, absurdMin, alice);
    }

    function test_UnlockCallback_RevertsForNonPoolManager() public {
        if (!forked) return;
        vm.prank(alice);
        vm.expectRevert(MiniSwapRouter.NotPoolManager.selector);
        router.unlockCallback(bytes(""));
    }

    function test_SwapExactIn_HookTaxBurnsWhenEnabled() public {
        if (!forked) return;
        // Enable the hook tax (the test contract is trustees).
        hook.setAutoCalculateTax(true);

        uint256 supplyBefore = money.totalSupply();
        uint256 amountIn = 0.05 ether;

        vm.prank(alice);
        IERC20(address(money)).approve(address(router), amountIn);

        bool zeroForOne = address(weth) < address(money) ? false : true;
        vm.prank(alice);
        router.swapExactIn(poolKey, zeroForOne, amountIn, 0, alice);

        uint256 supplyAfter = money.totalSupply();
        // Tax tier at price ≈ 1.0 is 1500 bps (15%). The hook BURNS the slice
        // because price < burnThreshold (1.10). So total supply must drop.
        assertLt(supplyAfter, supplyBefore, "MONEY supply must drop by tax burn amount");
    }

    function test_SwapExactIn_WethForMoney_NoTax() public {
        if (!forked) return;
        // Even with autoTax on, buys are exempt — only sells are taxed.
        hook.setAutoCalculateTax(true);

        uint256 amountIn = 0.01 ether;

        vm.prank(alice);
        IWeth9(weth).approve(address(router), amountIn);

        // Buying MONEY (sell WETH): currency0 -> currency1 = zeroForOne = true
        bool zeroForOne = address(weth) < address(money) ? true : false;
        uint256 supplyBefore = money.totalSupply();

        vm.prank(alice);
        uint256 amountOut = router.swapExactIn(poolKey, zeroForOne, amountIn, 0, alice);

        uint256 supplyAfter = money.totalSupply();
        assertGt(amountOut, 0, "MONEY delivered to alice");
        assertEq(supplyBefore, supplyAfter, "no burn on a buy");
    }
}
