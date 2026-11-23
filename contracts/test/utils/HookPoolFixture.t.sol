// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "./BaseTest.sol";

import {PegDefenseHook, PegDefenseHookPermissions} from "../../src/hooks/PegDefenseHook.sol";
import {OldMoney} from "../../src/tokens/OldMoney.sol";

import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {TransientStateLibrary} from "v4-core/src/libraries/TransientStateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Freely mintable stand-in for the paired asset.
contract FixtureWeth is ERC20 {
    constructor() ERC20("Wrapped Ether", "WETH") {}

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

/**
 * @notice Router that runs several swaps inside ONE `unlock`, settling only the net deltas
 *         at the end. Models multi-hop / multicall routers, where flash accounting lets
 *         opposite legs cancel before any token moves.
 */
contract BatchSwapRouter is IUnlockCallback {
    using TransientStateLibrary for IPoolManager;

    IPoolManager public immutable manager;

    struct Batch {
        address payer;
        PoolKey[] keys;
        SwapParams[] swaps;
    }

    constructor(
        IPoolManager _manager
    ) {
        manager = _manager;
    }

    function swapBatch(
        PoolKey[] memory keys,
        SwapParams[] memory swaps
    ) external {
        manager.unlock(abi.encode(Batch(msg.sender, keys, swaps)));
    }

    function unlockCallback(
        bytes calldata raw
    ) external returns (bytes memory) {
        require(msg.sender == address(manager), "BatchSwapRouter: not manager");
        Batch memory b = abi.decode(raw, (Batch));
        for (uint256 i = 0; i < b.swaps.length; ++i) {
            manager.swap(b.keys[i], b.swaps[i], "");
        }
        // Net settlement across every currency touched.
        for (uint256 i = 0; i < b.keys.length; ++i) {
            _resolve(b.keys[i].currency0, b.payer);
            _resolve(b.keys[i].currency1, b.payer);
        }
        return "";
    }

    function _resolve(
        Currency currency,
        address payer
    ) internal {
        int256 delta = manager.currencyDelta(address(this), currency);
        if (delta < 0) {
            manager.sync(currency);
            IERC20(Currency.unwrap(currency)).transferFrom(payer, address(manager), uint256(-delta));
            manager.settle();
        } else if (delta > 0) {
            manager.take(currency, payer, uint256(delta));
        }
    }
}

/**
 * @title HookPoolFixture
 * @notice Deploys a REAL v4-core PoolManager locally (no fork, no RPC) with the
 *         PegDefenseHook installed on a MONEY/WETH dynamic-fee pool, plus v4-core's test
 *         routers. Lets the swap-path tests exercise true flash accounting, hook deltas
 *         and settlement rather than a mocked manager.
 *
 *         Subclasses pick the token ordering through `_moneyIsCurrency0()` so every test
 *         runs in both orientations — the tax and oracle math both branch on it.
 *
 *         All prices and ticks in the helpers are expressed in MONEY terms ("money tick"
 *         = log_1.0001 of WETH-per-MONEY); `_poolTick` converts to the pool's orientation.
 */
abstract contract HookPoolFixture is BaseTest {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    PoolManager internal manager;
    PegDefenseHook internal hook;
    OldMoney internal money;
    FixtureWeth internal weth;
    PoolKey internal poolKey;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal liquidityRouter;
    BatchSwapRouter internal batchRouter;

    address internal treasuryAddr = makeAddr("treasury");

    int24 internal constant TICK_SPACING = 60;
    int24 internal constant FULL_RANGE_LOWER = -887_220;
    int24 internal constant FULL_RANGE_UPPER = 887_220;
    uint256 internal constant ACTOR_BALANCE = 1_000_000 ether;

    function _moneyIsCurrency0() internal pure virtual returns (bool);

    function setUp() public virtual override {
        super.setUp();
        vm.warp(1_700_000_000);

        manager = new PoolManager(address(this));
        money = new OldMoney();

        // Place WETH directly beside MONEY in address space to force the ordering.
        address wethAddr =
            _moneyIsCurrency0() ? address(uint160(address(money)) + 1) : address(uint160(address(money)) - 1);
        deployCodeTo("HookPoolFixture.t.sol:FixtureWeth", wethAddr);
        weth = FixtureWeth(wethAddr);

        address hookAddr = address(PegDefenseHookPermissions.FLAGS | (uint160(0xBEEF) << 144));
        deployCodeTo(
            "PegDefenseHook.sol:PegDefenseHook",
            abi.encode(IPoolManager(address(manager)), address(money), address(this)),
            hookAddr
        );
        hook = PegDefenseHook(hookAddr);
        hook.setTreasury(treasuryAddr);

        (Currency c0, Currency c1) = _moneyIsCurrency0()
            ? (Currency.wrap(address(money)), Currency.wrap(address(weth)))
            : (Currency.wrap(address(weth)), Currency.wrap(address(money)));
        poolKey = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hookAddr)
        });

        swapRouter = new PoolSwapTest(IPoolManager(address(manager)));
        liquidityRouter = new PoolModifyLiquidityTest(IPoolManager(address(manager)));
        batchRouter = new BatchSwapRouter(IPoolManager(address(manager)));

        _fund(address(this));
        _fund(alice);
        _fund(bob);
    }

    // ------------------------------------------------------------------
    // Setup helpers
    // ------------------------------------------------------------------

    function _fund(
        address who
    ) internal {
        money.mint(who, ACTOR_BALANCE);
        weth.mint(who, ACTOR_BALANCE);
        vm.startPrank(who);
        money.approve(address(swapRouter), type(uint256).max);
        weth.approve(address(swapRouter), type(uint256).max);
        money.approve(address(liquidityRouter), type(uint256).max);
        weth.approve(address(liquidityRouter), type(uint256).max);
        money.approve(address(batchRouter), type(uint256).max);
        weth.approve(address(batchRouter), type(uint256).max);
        vm.stopPrank();
    }

    /// @dev Money tick → pool tick. Negating a multiple of the spacing stays aligned.
    function _poolTick(
        int24 moneyTick
    ) internal pure returns (int24) {
        return _moneyIsCurrency0() ? moneyTick : -moneyTick;
    }

    function _initPool(
        int24 moneyTick
    ) internal {
        manager.initialize(poolKey, TickMath.getSqrtPriceAtTick(_poolTick(moneyTick)));
    }

    function _addLiquidity(
        int24 lower,
        int24 upper,
        int256 liquidity
    ) internal returns (BalanceDelta) {
        return liquidityRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: liquidity, salt: bytes32(0)}),
            ""
        );
    }

    /// @dev Initialise at `moneyTick` and seed deep full-range liquidity from the test contract.
    function _initWithFullRange(
        int24 moneyTick,
        int256 liquidity
    ) internal {
        _initPool(moneyTick);
        _addLiquidity(FULL_RANGE_LOWER, FULL_RANGE_UPPER, liquidity);
    }

    // ------------------------------------------------------------------
    // Swap helpers
    // ------------------------------------------------------------------

    function _sellParams(
        int256 amountSpecified
    ) internal pure returns (SwapParams memory) {
        return _params(_moneyIsCurrency0(), amountSpecified);
    }

    function _buyParams(
        int256 amountSpecified
    ) internal pure returns (SwapParams memory) {
        return _params(!_moneyIsCurrency0(), amountSpecified);
    }

    function _params(
        bool zeroForOne,
        int256 amountSpecified
    ) internal pure returns (SwapParams memory) {
        return SwapParams({
            zeroForOne: zeroForOne,
            amountSpecified: amountSpecified,
            sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
        });
    }

    function _swap(
        address who,
        SwapParams memory params
    ) internal returns (BalanceDelta delta) {
        vm.prank(who);
        delta = swapRouter.swap(poolKey, params, PoolSwapTest.TestSettings(false, false), "");
    }

    /// @dev Sell exactly `moneyIn` MONEY (gross, tax included).
    function _sellExactIn(
        address who,
        uint256 moneyIn
    ) internal returns (BalanceDelta) {
        return _swap(who, _sellParams(-int256(moneyIn)));
    }

    /// @dev Sell however much MONEY it takes to receive exactly `wethOut`.
    function _sellExactOut(
        address who,
        uint256 wethOut
    ) internal returns (BalanceDelta) {
        return _swap(who, _sellParams(int256(wethOut)));
    }

    function _buyExactIn(
        address who,
        uint256 wethIn
    ) internal returns (BalanceDelta) {
        return _swap(who, _buyParams(-int256(wethIn)));
    }

    function _buyExactOut(
        address who,
        uint256 moneyOut
    ) internal returns (BalanceDelta) {
        return _swap(who, _buyParams(int256(moneyOut)));
    }

    // ------------------------------------------------------------------
    // Read helpers
    // ------------------------------------------------------------------

    function _currentPoolTick() internal view returns (int24 tick) {
        (, tick,,) = IPoolManager(address(manager)).getSlot0(poolKey.toId());
    }

    function _enableTax() internal {
        hook.setAutoCalculateTax(true);
    }
}
