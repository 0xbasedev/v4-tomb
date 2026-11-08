// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MasonryPooledRangeVault} from "../../src/masonry/MasonryPooledRangeVault.sol";
import {MasonryRangeLib} from "../../src/masonry/MasonryRangeLib.sol";
import {MasonryLevelPrice} from "../../src/masonry/MasonryLevelPrice.sol";

contract MockAsset is ERC20 {
    constructor(string memory name_) ERC20(name_, name_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MockQuote is ERC20 {
    constructor() ERC20("USDG", "USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract MasonryPooledRangeVaultTest is Test {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    PoolManager private manager;
    PoolSwapTest private swaps;
    PoolModifyLiquidityTest private liqRouter;
    MockQuote private usdg;

    address private alice = address(0xA11CE);
    address private bob = address(0xB0B);

    function setUp() public {
        manager = new PoolManager(address(this));
        swaps = new PoolSwapTest(manager);
        liqRouter = new PoolModifyLiquidityTest(manager);
        usdg = new MockQuote();
    }

    function testTwoUsersDepositAndRedeemAtPeg() public {
        Env memory e = _boot();
        MasonryPooledRangeVault vault = _vault(e, MasonryPooledRangeVault.Strategy.FixedPeg, 1500);
        _deposit(e, vault, alice, 10_000e18, 10_000e6);
        _deposit(e, vault, bob, 10_000e18, 10_000e6);
        assertApproxEqRel(vault.balanceOf(alice), vault.balanceOf(bob), 0.02e18);
        uint256 aliceAsset = e.asset.balanceOf(alice);
        uint256 aliceQuote = usdg.balanceOf(alice);
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        (uint256 out0, uint256 out1) = vault.redeem(aliceShares);
        assertGt(out0 + out1, 0);
        assertGt(e.asset.balanceOf(alice) + usdg.balanceOf(alice), aliceAsset); // received tokens (mixed decimals)
        assertGt(e.asset.balanceOf(alice), aliceAsset);
        assertTrue(usdg.balanceOf(alice) >= aliceQuote);
        (uint256 remain0, uint256 remain1) = vault.inventory();
        assertGt(remain0 + remain1, 0);
        assertGt(vault.balanceOf(bob), 0);
    }

    function testRedeemWaveDuringDepegLeavesReserves() public {
        Env memory e = _boot();
        MasonryPooledRangeVault vault = _vault(e, MasonryPooledRangeVault.Strategy.PegAnchor, 1500);
        _deposit(e, vault, alice, 20_000e18, 20_000e6);
        _deposit(e, vault, bob, 20_000e18, 20_000e6);
        _sellToward(e, 2000);
        (uint160 sqrtAfter,,,) = IPoolManager(address(manager)).getSlot0(e.key.toId());
        uint256 price = MasonryLevelPrice.fromSqrtPrice(sqrtAfter, e.asset0);
        assertLt(price, 0.9e18);

        vault.rebalance();
        (int24 lower, int24 upper) = vault.previewBand();
        int24 pegTick = TickMath.getTickAtSqrtPrice(e.peg);
        assertTrue(MasonryRangeLib.containsTick(pegTick, lower, upper), "peg-anchor still covers $1 after depeg");

        uint256 bobShares = vault.balanceOf(bob);
        vm.prank(bob);
        (uint256 bob0, uint256 bob1) = vault.redeem(bobShares);
        assertGt(bob0 + bob1, 0);
        // During a depeg the position is asset-heavy; the redeemer should not drain all USDG.
        (, uint256 usdgLeft) = vault.inventory();
        assertGt(usdgLeft, 0, "pooled vault must keep USDG after a partial depeg redemption");
        assertGt(vault.balanceOf(alice), 0);

        uint256 bobValue = MasonryRangeLib.valueInCurrency1(
            e.asset0 ? bob0 : bob1, e.asset0 ? bob1 : bob0, sqrtAfter
        );
        // 20k USDG was deposited (6 decimals live in currency1 or currency0).
        // Mark the payout; it should be below the deposit once Fire-Tax-free but IL/impact apply.
        assertGt(bobValue, 0);
    }

    function testFollowRebalanceAbandonsPegOnDeepDepeg() public {
        Env memory e = _boot();
        MasonryPooledRangeVault vault = _vault(e, MasonryPooledRangeVault.Strategy.Follow, 1500);
        _deposit(e, vault, alice, 20_000e18, 20_000e6);
        _sellToward(e, 2000);
        vault.rebalance();
        (int24 lower, int24 upper) = vault.previewBand();
        int24 pegTick = TickMath.getTickAtSqrtPrice(e.peg);
        assertFalse(
            MasonryRangeLib.containsTick(pegTick, lower, upper),
            "follow recentered onto the depeg no longer reaches $1"
        );
    }

    function testFixedBandStaysOnPeg() public {
        Env memory e = _boot();
        MasonryPooledRangeVault vault = _vault(e, MasonryPooledRangeVault.Strategy.FixedPeg, 1500);
        _deposit(e, vault, alice, 20_000e18, 20_000e6);
        (int24 beforeL, int24 beforeU) = (vault.tickLower(), vault.tickUpper());
        _sellToward(e, 2000);
        vault.rebalance();
        assertEq(vault.tickLower(), beforeL);
        assertEq(vault.tickUpper(), beforeU);
        int24 pegTick = TickMath.getTickAtSqrtPrice(e.peg);
        assertTrue(MasonryRangeLib.containsTick(pegTick, beforeL, beforeU));
    }

    struct Env {
        MockAsset asset;
        bool asset0;
        PoolKey key;
        uint160 peg;
    }

    function _boot() private returns (Env memory e) {
        e.asset = new MockAsset("xTOMB");
        e.asset0 = address(e.asset) < address(usdg);
        e.key = PoolKey({
            currency0: Currency.wrap(e.asset0 ? address(e.asset) : address(usdg)),
            currency1: Currency.wrap(e.asset0 ? address(usdg) : address(e.asset)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        e.peg = uint160(e.asset0 ? (uint256(1) << 96) / 1e6 : (uint256(1) << 96) * 1e6);
        manager.initialize(e.key, e.peg);
        e.asset.mint(address(this), 5_000_000e18);
        usdg.mint(address(this), 5_000_000e6);
        e.asset.approve(address(liqRouter), type(uint256).max);
        usdg.approve(address(liqRouter), type(uint256).max);
        e.asset.approve(address(swaps), type(uint256).max);
        usdg.approve(address(swaps), type(uint256).max);
        int24 center = TickMath.getTickAtSqrtPrice(e.peg) / 60 * 60;
        liqRouter.modifyLiquidity(e.key, ModifyLiquidityParams(center - 6000, center + 6000, 1e16, 0), "");
    }

    function _vault(
        Env memory e,
        MasonryPooledRangeVault.Strategy strategy,
        uint16 width
    ) private returns (MasonryPooledRangeVault vault) {
        vault = new MasonryPooledRangeVault(manager, e.key, strategy, width, e.peg);
    }

    function _deposit(
        Env memory e,
        MasonryPooledRangeVault vault,
        address user,
        uint256 assetAmt,
        uint256 quoteAmt
    ) private {
        e.asset.mint(user, assetAmt);
        usdg.mint(user, quoteAmt);
        vm.startPrank(user);
        e.asset.approve(address(vault), type(uint256).max);
        usdg.approve(address(vault), type(uint256).max);
        if (e.asset0) vault.deposit(assetAmt, quoteAmt);
        else vault.deposit(quoteAmt, assetAmt);
        vm.stopPrank();
    }

    function _sellToward(Env memory e, int24 tickDelta) private {
        (, int24 tick,,) = IPoolManager(address(manager)).getSlot0(e.key.toId());
        int24 target = e.asset0 ? tick - tickDelta : tick + tickDelta;
        // asset0: cheaper asset raises token1/token0, so zeroForOne=false? 
        // Selling asset: if asset is token0, zeroForOne=true (sell token0).
        // tick for token0/token1: selling token0 decreases sqrt price.
        // MasonryRangeManager tests: target = asset0 ? tick - delta : tick + delta with zeroForOne: asset0
        // Wait, they used tick - delta when asset0. Selling token0 decreases tick.
        // But cheaper LEVEL when LEVEL is token0 means USDG/LEVEL increases... 
        // token1/token0 = USDG/LEVEL increases when LEVEL cheaper, tick INCREASES, so they should add to tick?
        // Their test: `target = e.asset0 ? tick - tickDelta` and zeroForOne: asset0 (sell asset).
        // Selling token0 decreases pool price token1/token0. If asset is token0, selling asset decreases USDG/LEVEL,
        // which means LEVEL became MORE expensive. That's a PUMP not a depeg!
        //
        // MasonryLevelPrice asset0: price = sqrt^2 * 1e30 / Q96^2 related to token1/token0.
        // If they sell asset (token0), token1/token0 drops, fromSqrtPrice drops... 
        // fromSqrtPrice asset0: sqrt^2 * 1e30 / 2^192 = token1/token0 * 1e30.
        // token1/token0 = USDG/LEVEL small when LEVEL expensive.
        // Selling LEVEL (token0) -> more LEVEL in pool -> LEVEL cheaper -> USDG/LEVEL increases? 
        // Constant product: sell token0 -> get token1 -> reserve0 up, reserve1 down -> price token1/token0 down.
        // token1/token0 down = USDG per LEVEL down = LEVEL more expensive. PUMP!
        //
        // I'm confused vs their comment "assertLe(price, 0.9e18)" after _sellToward 1300 with zeroForOne: asset0.
        // They sell huge asset with limit toward tick - 1300 (lower tick) when asset0.
        // Lower tick = lower token1/token0. fromSqrtPrice asset0 uses sqrt^2 * 1e30 which DECREASES. Price DOWN.
        // So their "price" is token1/token0 scaled = USDG/LEVEL? USDG/LEVEL down = LEVEL more expensive.
        // But they assert price <= 0.9e18 meaning their "price" went down.
        // They call it depeg (LEVEL below peg). So they treat fromSqrtPrice as LEVEL in USDG.
        //
        // asset0: fromSqrtPrice = token1/token0 * 1e30 / 1? If that goes down, LEVEL/USDG goes down if the formula
        // actually represents LEVEL price...
        // Earlier I calculated asset0 (token0=LEVEL, token1=USDG): token1/token0 = 1/(P*1e12), *1e30 = 1e18/P
        // That would be INVERSE - selling token0 lowers token1/token0, increases 1e18/P so P decreases. Yes! P = LEVEL price.
        // Selling LEVEL (token0) increases 1/P displayed as fromSqrtPrice decreasing? 
        // token1/token0 decreases -> formula asset0: sqrt^2*1e30/Q96^2 decreases -> they call that price. assert <= 0.9.
        // So selling token0 (LEVEL) makes their price metric go DOWN = depeg. OK they have it right empirically.
        // Use the same direction as MasonryRangeManager.t.sol.
        swaps.swap(
            e.key,
            SwapParams({
                zeroForOne: e.asset0,
                amountSpecified: -int256(1_000_000e18),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(target)
            }),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
    }
}
