// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";
import {HookMiner} from "../utils/HookMiner.sol";

import {OldMoney} from "../../src/tokens/OldMoney.sol";
import {Estate} from "../../src/tokens/Estate.sol";
import {TrustNote} from "../../src/tokens/TrustNote.sol";
import {Treasury} from "../../src/core/Treasury.sol";
import {Boardroom} from "../../src/core/Boardroom.sol";
import {Oracle} from "../../src/oracle/Oracle.sol";
import {PegDefenseHook} from "../../src/hooks/PegDefenseHook.sol";
import {HistoricalAddresses as Addresses} from "../fixtures/HistoricalAddresses.sol";
import {ITreasury} from "../../src/interfaces/ITreasury.sol";
import {IPriceSource} from "../../src/interfaces/IPriceSource.sol";

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";

import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Minimal WETH9 surface: deposit() to wrap ETH, transfer/approve/balanceOf inherited.
interface IWeth9 {
    function deposit() external payable;
    function withdraw(
        uint256
    ) external;
}

/**
 * @title BaseForkHookTaxTest
 * @notice Real-V4 fork integration tests for the Sprint 4b tax surface. Validates that:
 *           1. A real `swap` through V4's PoolManager triggers `beforeSwap` and the
 *              hook's `take` call inside the unlock context.
 *           2. The burn path reduces `money.totalSupply` by exactly the tax amount.
 *           3. The route path increases `treasury.balanceOf` by exactly the tax amount.
 *           4. Buy direction (the opposite swap direction) is untaxed.
 *           5. Excluded sender bypasses tax even on sells.
 *
 *         Uses v4-core's `PoolSwapTest` + `PoolModifyLiquidityTest` helpers — the standard
 *         test routers used throughout the V4 codebase. They implement the unlock-callback
 *         pattern and handle settle/take for the caller, so our test contract just calls
 *         `poolSwapTest.swap(...)` and `poolModifyLiquidityTest.modifyLiquidity(...)`.
 *
 *         Gated on `BASE_RPC_URL` — skipped if unset.
 */
contract BaseForkHookTaxTest is BaseTest {
    using PoolIdLibrary for PoolKey;

    OldMoney internal money;
    Estate internal estate;
    TrustNote internal trustnote;
    Treasury internal treasury;
    Boardroom internal boardroom;
    Oracle internal oracle;
    PegDefenseHook internal hook;
    IPoolManager internal poolManager;
    PoolKey internal poolKey;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal liquidityRouter;

    address internal weth;
    address internal genesisPool = makeAddr("genesisPool");
    address internal mainPool = makeAddr("mainPool");
    address internal airdropWallet = makeAddr("airdropWallet");
    address internal farmingPool = makeAddr("farmingPool");
    address internal communityFund = makeAddr("communityFund");
    address internal devFund = makeAddr("devFund");

    uint256 internal startTime;
    bool internal forked;

    // Pre-funded balances available for swap tests.
    uint256 internal constant TEST_MONEY_BAL = 1000 ether;
    uint256 internal constant TEST_WETH_BAL = 1000 ether;
    int24 internal constant LIQ_TICK_LOWER = -6000;
    int24 internal constant LIQ_TICK_UPPER = 6000;

    function setUp() public override {
        string memory url = vm.envOr("BASE_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }

        vm.createSelectFork(url);
        forked = true;

        super.setUp();

        startTime = block.timestamp + 1 hours;
        poolManager = IPoolManager(Addresses.poolManager());
        weth = Addresses.weth();

        // Deploy tokens. Test contract is the deployer + initial trustees.
        money = new OldMoney();
        estate = new Estate(startTime, communityFund, devFund);
        trustnote = new TrustNote();

        // CREATE2-mine + deploy the PegDefenseHook at the required permission-bit address.
        uint160 flags =
            uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG);
        bytes memory hookCreationCode =
            abi.encodePacked(type(PegDefenseHook).creationCode, abi.encode(poolManager, address(money), address(this)));
        (address minedAddr, bytes32 hookSalt) = HookMiner.find(address(this), flags, hookCreationCode);
        PegDefenseHook deployedHook;
        bytes32 saltLocal = hookSalt;
        bytes memory codeLocal = hookCreationCode;
        assembly {
            deployedHook := create2(0, add(codeLocal, 0x20), mload(codeLocal), saltLocal)
        }
        require(address(deployedHook) == minedAddr, "BaseForkHookTax: hook addr mismatch");
        hook = deployedHook;

        // Initialize the V4 MONEY/WETH pool at parity (tick 0).
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
        poolManager.initialize(poolKey, TickMath.getSqrtPriceAtTick(0));

        // Deploy Oracle pointing at the hook as IPriceSource.
        oracle = new Oracle(IPriceSource(address(hook)), address(money), weth, 6 hours, startTime);

        // Deploy Treasury + Boardroom, init, hand off operator.
        treasury = new Treasury();
        boardroom = new Boardroom();
        boardroom.initialize(IERC20(address(money)), IERC20(address(estate)), ITreasury(address(treasury)));

        address[] memory excluded = new address[](3);
        excluded[0] = genesisPool;
        excluded[1] = mainPool;
        excluded[2] = airdropWallet;
        treasury.initialize(
            address(money),
            address(trustnote),
            address(estate),
            address(oracle),
            address(boardroom),
            startTime,
            excluded
        );

        money.distributeReward(genesisPool, mainPool, airdropWallet);
        estate.distributeReward(farmingPool);

        // Pre-fund the TEST CONTRACT with MONEY for swap tests. Must happen BEFORE
        // the trustees handoff to Treasury (otherwise test contract loses mint authority).
        money.mint(address(this), TEST_MONEY_BAL);

        // Hand off operator authority on every token + boardroom to Treasury.
        money.transferTrustees(address(treasury));
        estate.transferTrustees(address(treasury));
        trustnote.transferTrustees(address(treasury));
        boardroom.setOperator(address(treasury));

        // Boardroom seed so bootstrap-branch allocateSeigniorage doesn't revert (gap #16).
        estate.approve(address(boardroom), 1);
        boardroom.stake(1);

        // Acquire WETH on the fork by depositing ETH at the OP-stack predeploy.
        vm.deal(address(this), TEST_WETH_BAL);
        IWeth9(weth).deposit{value: TEST_WETH_BAL}();

        // Wire Treasury into the hook so the route path has a destination.
        hook.setTreasury(address(treasury));

        // Deploy v4-core test routers + approve them on both currencies.
        swapRouter = new PoolSwapTest(poolManager);
        liquidityRouter = new PoolModifyLiquidityTest(poolManager);
        IERC20(address(money)).approve(address(swapRouter), type(uint256).max);
        IERC20(address(money)).approve(address(liquidityRouter), type(uint256).max);
        IERC20(weth).approve(address(swapRouter), type(uint256).max);
        IERC20(weth).approve(address(liquidityRouter), type(uint256).max);

        // Add liquidity to the pool — modest LP around tick 0 so swaps have depth.
        liquidityRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({
                tickLower: LIQ_TICK_LOWER, tickUpper: LIQ_TICK_UPPER, liquidityDelta: 1000e18, salt: bytes32(0)
            }),
            ""
        );

        vm.warp(startTime + 1);
    }

    // ---------------------------------------------------------------------
    // Sprint 4b — burn-path sell
    // ---------------------------------------------------------------------

    function test_BurnPath_SellBelowThreshold_ReducesSupply() public {
        // Enable tax. burnThreshold defaults to 1.10e18 and current price is ~1.0e18,
        // so the burn branch fires.
        hook.setAutoCalculateTax(true);

        uint256 totalBefore = money.totalSupply();
        uint256 sellAmount = 10 ether;

        // At tick 0, rate = tier 7 = 1500 bps. Tax = sellAmount * 0.15.
        uint256 expectedTax = sellAmount * 1500 / 10_000;

        SwapParams memory params = _sellSwapParams(int256(sellAmount));
        swapRouter.swap(poolKey, params, PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}), "");

        // totalSupply decreased by exactly the tax amount (burn path).
        assertEq(money.totalSupply(), totalBefore - expectedTax, "totalSupply should decrease by tax amount");
        // Hook holds no MONEY after burn.
        assertEq(money.balanceOf(address(hook)), 0, "hook MONEY balance is 0 after burn");
        // Treasury didn't receive anything (we're below threshold).
        assertEq(money.balanceOf(address(treasury)), 0, "treasury unchanged on burn path");
    }

    // ---------------------------------------------------------------------
    // Sprint 4b — route-path sell
    // ---------------------------------------------------------------------

    function test_RoutePath_SellAboveThreshold_RoutesToTreasury() public {
        // Lower burnThreshold so any price exceeds it -> route path fires.
        hook.setBurnThreshold(0.5e18);
        hook.setAutoCalculateTax(true);

        uint256 totalBefore = money.totalSupply();
        uint256 treasuryBefore = money.balanceOf(address(treasury));
        uint256 sellAmount = 10 ether;
        uint256 expectedTax = sellAmount * 1500 / 10_000;

        SwapParams memory params = _sellSwapParams(int256(sellAmount));
        swapRouter.swap(poolKey, params, PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}), "");

        // Total supply unchanged (no burn).
        assertEq(money.totalSupply(), totalBefore, "totalSupply unchanged on route path");
        // Treasury received tax.
        assertEq(money.balanceOf(address(treasury)), treasuryBefore + expectedTax, "treasury received tax");
        // Hook holds nothing.
        assertEq(money.balanceOf(address(hook)), 0, "hook MONEY balance is 0 after route");
    }

    // ---------------------------------------------------------------------
    // Sprint 4b — buy direction skipped
    // ---------------------------------------------------------------------

    function test_BuyDirection_NoTaxApplied() public {
        hook.setAutoCalculateTax(true);

        uint256 totalBefore = money.totalSupply();
        uint256 treasuryBefore = money.balanceOf(address(treasury));
        uint256 buyAmount = 10 ether;

        // BUY: WETH -> MONEY. zeroForOne flipped from the sell direction.
        SwapParams memory params = SwapParams({
            zeroForOne: !hook.moneyIsCurrency0(),
            amountSpecified: -int256(buyAmount),
            sqrtPriceLimitX96: hook.moneyIsCurrency0() ? TickMath.MAX_SQRT_PRICE - 1 : TickMath.MIN_SQRT_PRICE + 1
        });
        swapRouter.swap(poolKey, params, PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}), "");

        // Nothing burned, nothing routed.
        assertEq(money.totalSupply(), totalBefore, "totalSupply unchanged on buy");
        assertEq(money.balanceOf(address(treasury)), treasuryBefore, "treasury unchanged on buy");
        assertEq(money.balanceOf(address(hook)), 0, "hook MONEY balance is 0 on buy");
    }

    // ---------------------------------------------------------------------
    // Sprint 4b — excluded sender skipped
    // ---------------------------------------------------------------------

    function test_ExcludedSender_NoTaxApplied() public {
        hook.setAutoCalculateTax(true);

        // The swapRouter IS the `sender` to beforeSwap (it's the contract calling
        // PoolManager.swap). Excluding it disables tax for swaps routed through this
        // router specifically.
        hook.setExcludedAddress(address(swapRouter), true);

        uint256 totalBefore = money.totalSupply();
        uint256 sellAmount = 10 ether;

        SwapParams memory params = _sellSwapParams(int256(sellAmount));
        swapRouter.swap(poolKey, params, PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}), "");

        assertEq(money.totalSupply(), totalBefore, "totalSupply unchanged when sender excluded");
    }

    // ---------------------------------------------------------------------
    // Sprint 4b — tax-off sanity check
    // ---------------------------------------------------------------------

    function test_TaxOff_BehavesLikeSprint4() public {
        // autoCalculateTax defaults to false. No tax, no delta, total supply unchanged.
        assertFalse(hook.autoCalculateTax(), "precondition: tax off");

        uint256 totalBefore = money.totalSupply();
        uint256 sellAmount = 10 ether;

        SwapParams memory params = _sellSwapParams(int256(sellAmount));
        swapRouter.swap(poolKey, params, PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}), "");

        assertEq(money.totalSupply(), totalBefore, "totalSupply unchanged when tax off");
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// @dev Exact-input MONEY sell. amountSpecified is positive in this helper's input;
    ///      we negate to match V4's exact-input convention (< 0).
    function _sellSwapParams(
        int256 sellAmount
    ) internal view returns (SwapParams memory) {
        bool zeroForOne = hook.moneyIsCurrency0();
        return SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: -sellAmount,
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
    }
}
