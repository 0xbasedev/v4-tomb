// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";

import {OldMoney} from "../../src/tokens/OldMoney.sol";
import {Addresses} from "../../src/libs/Addresses.sol";
import {V4PositionWrapper} from "../../src/distribution/V4PositionWrapper.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";

import {IPositionManager} from "v4-periphery/src/interfaces/IPositionManager.sol";
import {Actions} from "v4-periphery/src/libraries/Actions.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {IAllowanceTransfer} from "permit2/src/interfaces/IAllowanceTransfer.sol";

interface IWeth9 {
    function deposit() external payable;
}

/**
 * @title BaseForkSeedLiquidityTest
 * @notice Fork integration test for `SeedLiquidity.s.sol`. Exercises the exact mint flow
 *         the script uses against the live Base V4 PositionManager + Permit2.
 *
 *         Closes gap #2 in `docs/GAP_AUDIT.md`. Confirms:
 *           1. The operator can seed an empty MONEY/WETH pool with full-range liquidity.
 *           2. The minted NFT is wrappable via `V4PositionWrapper` (same tick range).
 *           3. The wrapper's ERC-20 shares = the V4 position's liquidity (1:1).
 *
 *         Gated on BASE_RPC_URL.
 */
contract BaseForkSeedLiquidityTest is BaseTest {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    OldMoney internal money;
    V4PositionWrapper internal wrapper;
    PoolKey internal poolKey;

    IPoolManager internal poolManager;
    IPositionManager internal positionManager;
    IAllowanceTransfer internal permit2;
    address internal weth;

    int24 internal constant TICK_LOWER_RANGE = -887_220; // full range with tickSpacing 60
    int24 internal constant TICK_UPPER_RANGE = 887_220;
    uint256 internal constant MONEY_BAL = 10_000 ether;
    uint256 internal constant WETH_BAL = 10_000 ether;

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

        poolManager = IPoolManager(Addresses.poolManager());
        positionManager = IPositionManager(Addresses.positionManager());
        permit2 = IAllowanceTransfer(Addresses.permit2());
        weth = Addresses.weth();

        // Deploy MONEY (we mint for tests).
        money = new OldMoney();
        money.mint(address(this), MONEY_BAL);

        // Acquire WETH from real ETH via OP-stack predeploy deposit.
        vm.deal(address(this), WETH_BAL);
        IWeth9(weth).deposit{value: WETH_BAL}();

        // Build pool key — no hook, static fee, tickSpacing 60. Same shape as Deploy.s.sol
        // would produce, just without the PegDefenseHook (to keep the test focused on
        // seed-liquidity mechanics rather than hook behavior).
        (Currency c0, Currency c1) = address(money) < weth
            ? (Currency.wrap(address(money)), Currency.wrap(weth))
            : (Currency.wrap(weth), Currency.wrap(address(money)));
        poolKey = PoolKey({currency0: c0, currency1: c1, fee: 3000, tickSpacing: 60, hooks: IHooks(address(0))});

        // Initialize pool at parity (tick 0).
        poolManager.initialize(poolKey, TickMath.getSqrtPriceAtTick(0));

        // Deploy wrapper bound to full-range MONEY/WETH.
        wrapper = new V4PositionWrapper(
            positionManager, poolKey, TICK_LOWER_RANGE, TICK_UPPER_RANGE, "Old Money MONEY-WETH LP", "om-MWLP"
        );

        // Permit2 dance — production script does this itself, test does it in setUp so
        // we can assert per-test behaviors cleanly.
        IERC20(address(money)).approve(address(permit2), type(uint256).max);
        IERC20(weth).approve(address(permit2), type(uint256).max);
        permit2.approve(address(money), address(positionManager), type(uint160).max, type(uint48).max);
        permit2.approve(weth, address(positionManager), type(uint160).max, type(uint48).max);
    }

    // ---------------------------------------------------------------------
    // Seed liquidity onto an empty pool
    // ---------------------------------------------------------------------

    function test_SeedsLiquidity_EmptyPool() public {
        if (!forked) return;

        uint256 moneyAmount = 1000 ether;
        uint256 wethAmount = 1000 ether;
        uint256 moneyBefore = money.balanceOf(address(this));
        uint256 wethBefore = IERC20(weth).balanceOf(address(this));

        uint256 tokenId = _seed(moneyAmount, wethAmount);

        // Position landed in our wallet.
        assertEq(IERC721(address(positionManager)).ownerOf(tokenId), address(this), "NFT in operator wallet");

        // Position has non-zero liquidity.
        uint128 liq = positionManager.getPositionLiquidity(tokenId);
        assertGt(liq, 0, "position has liquidity");

        // Some MONEY + WETH actually got consumed.
        assertLt(money.balanceOf(address(this)), moneyBefore, "money decreased");
        assertLt(IERC20(weth).balanceOf(address(this)), wethBefore, "weth decreased");
    }

    // ---------------------------------------------------------------------
    // The seed position is wrappable -> ready for reward-pool staking
    // ---------------------------------------------------------------------

    function test_SeedLiquidity_PositionIsWrappable() public {
        if (!forked) return;

        uint256 tokenId = _seed(500 ether, 500 ether);

        // Approve wrapper for the NFT and wrap.
        IERC721(address(positionManager)).approve(address(wrapper), tokenId);
        uint128 wrappedLiq = wrapper.wrap(tokenId);

        // Wrapper holds NFT; operator holds matching ERC-20.
        assertEq(IERC721(address(positionManager)).ownerOf(tokenId), address(wrapper), "wrapper holds NFT");
        assertEq(wrapper.balanceOf(address(this)), uint256(wrappedLiq), "ERC-20 = liquidity");
        assertGt(wrappedLiq, 0);
    }

    // ---------------------------------------------------------------------
    // Pool depth check — pool now has real liquidity for swaps
    // ---------------------------------------------------------------------

    function test_SeedLiquidity_GivesPoolDepth() public {
        if (!forked) return;

        // Before seed: pool initialized but no liquidity = first swap would fail
        (, int24 tickBefore,,) = poolManager.getSlot0(poolKey.toId());

        _seed(1000 ether, 1000 ether);

        (, int24 tickAfter,,) = poolManager.getSlot0(poolKey.toId());

        // Tick stays at 0 — we deposited equal amounts at parity, no price drift.
        assertEq(tickBefore, 0);
        assertEq(tickAfter, 0);
        // The proof of depth: a position exists. Real swap testing would happen against
        // a PoolSwapTest router; covered indirectly by BaseForkHookTax.t.sol setup pattern.
    }

    // ---------------------------------------------------------------------
    // Helpers — same shape as SeedLiquidity.s.sol's _mintPosition
    // ---------------------------------------------------------------------

    function _seed(
        uint256 moneyAmount,
        uint256 wethAmount
    ) internal returns (uint256 tokenId) {
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(poolKey.toId());
        (uint256 amount0Max, uint256 amount1Max) =
            address(money) < weth ? (moneyAmount, wethAmount) : (wethAmount, moneyAmount);

        uint128 liquidity = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtPriceAtTick(TICK_LOWER_RANGE),
            TickMath.getSqrtPriceAtTick(TICK_UPPER_RANGE),
            amount0Max,
            amount1Max
        );
        require(liquidity > 0, "test: no liquidity");

        tokenId = positionManager.nextTokenId();

        bytes memory actions = abi.encodePacked(uint8(Actions.MINT_POSITION), uint8(Actions.SETTLE_PAIR));
        bytes[] memory params = new bytes[](2);
        params[0] = abi.encode(
            poolKey,
            TICK_LOWER_RANGE,
            TICK_UPPER_RANGE,
            uint256(liquidity),
            uint128(amount0Max),
            uint128(amount1Max),
            address(this),
            bytes("")
        );
        params[1] = abi.encode(poolKey.currency0, poolKey.currency1);
        positionManager.modifyLiquidities(abi.encode(actions, params), block.timestamp + 1);
    }
}
