// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId} from "v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MasonryLevelHook, IMasonryLevelTwap} from "../../src/hooks/MasonryLevelHook.sol";
import {MasonryGenesisSchedule} from "../../src/masonry/MasonryGenesisSchedule.sol";
import {MockMasonryLevel, MockMasonryUSDC} from "../unit/MasonryGenesisLPBurnFee.t.sol";
import {HookMiner} from "../utils/HookMiner.sol";

contract MasonryLevelHookTest is Test, IMasonryLevelTwap {
    MockMasonryLevel private level;
    MockMasonryUSDC private usdc;
    MasonryGenesisSchedule private schedule;
    MasonryLevelHook private hook;
    PoolSwapTest private swaps;
    PoolKey private key;
    bool private level0;
    uint256 private twap = 1e18;
    address private constant TREASURY = address(0x777);

    function validatedPrice(
        PoolId
    ) external view returns (uint256) {
        return twap;
    }

    function setUp() public {
        level = new MockMasonryLevel();
        usdc = new MockMasonryUSDC();
        schedule = new MasonryGenesisSchedule(block.timestamp + 1 days);
        PoolManager manager = new PoolManager(address(this));
        swaps = new PoolSwapTest(manager);
        PoolModifyLiquidityTest liquidity = new PoolModifyLiquidityTest(manager);
        uint160 flags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG;
        bytes memory args = abi.encode(manager, schedule, this, level, usdc, TREASURY, uint24(3000), int24(60));
        (, bytes32 salt) = HookMiner.find(address(this), flags, bytes.concat(type(MasonryLevelHook).creationCode, args));
        hook = new MasonryLevelHook{salt: salt}(
            manager, schedule, this, address(level), address(usdc), TREASURY, 3000, 60
        );
        level0 = address(level) < address(usdc);
        key = PoolKey(
            Currency.wrap(level0 ? address(level) : address(usdc)),
            Currency.wrap(level0 ? address(usdc) : address(level)),
            3000,
            60,
            IHooks(address(hook))
        );
        uint160 peg = uint160(level0 ? (uint256(1) << 96) / 1e6 : (uint256(1) << 96) * 1e6);
        manager.initialize(key, peg);
        level.mint(address(this), 1_000_000e18);
        usdc.mint(address(this), 1_000_000e6);
        level.approve(address(liquidity), type(uint256).max);
        usdc.approve(address(liquidity), type(uint256).max);
        level.approve(address(swaps), type(uint256).max);
        usdc.approve(address(swaps), type(uint256).max);
        int24 tick = TickMath.getTickAtSqrtPrice(peg);
        int24 center = tick / 60 * 60;
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(center - 6000, center + 6000, 1e16, 0), "");
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(center - 120, center + 120, 1e16, 0), "");
    }

    function testTaxBoundariesAndNonDuplication() public {
        vm.warp(schedule.start() - 1);
        _swap(level0, -10e18);
        assertEq(level.balanceOf(TREASURY), 0.1e18);
        assertEq(level.totalBurned(), 0);

        vm.warp(schedule.start());
        uint256 before = level.balanceOf(address(this));
        _swap(level0, -10e18);
        assertEq(before - level.balanceOf(address(this)), 10e18);
        assertEq(level.totalBurned(), 0.3e18);
        assertEq(hook.genesisLevelBurned(), 0.3e18);
        assertEq(level.balanceOf(TREASURY), 0.1e18);
        assertEq(hook.raisedBps(), 100);

        vm.warp(schedule.end() - 1);
        _swap(level0, -10e18);
        assertEq(level.totalBurned(), 0.6e18);

        vm.warp(schedule.end());
        _swap(level0, -10e18);
        assertEq(level.totalBurned(), 0.6e18);
        assertEq(level.balanceOf(TREASURY), 0.2e18);
    }

    function testBuyAndTransferAreUntaxedEvenWhenSellOracleIsUnavailable() public {
        vm.warp(schedule.start());
        twap = 0;
        _swap(!level0, -100e6);
        _swap(!level0, 10e18);
        level.transfer(TREASURY, 10e18);
        assertEq(level.balanceOf(TREASURY), 10e18);
        assertEq(level.totalBurned(), 0);
        assertEq(hook.genesisLevelBurned(), 0);
    }

    function testProjectedTickCrossingAppliesCeilingOnSameSale() public {
        vm.warp(schedule.start());
        _swap(level0, -1100e18);
        assertEq(level.totalBurned(), 132e18);
        assertEq(hook.raisedBps(), 1200);
        _swap(!level0, -2000e6); // Recover spot; leave the sell recovery floor in place.
        vm.warp(schedule.start() + 3.5 hours);
        _swap(level0, -100e18);
        assertEq(level.totalBurned(), 138.5e18);
        vm.warp(schedule.start() + 7 hours);
        _swap(level0, -100e18);
        assertEq(level.totalBurned(), 141.5e18);
    }

    function testOrdinaryRecoveryPersistsAfterGenesisEnds() public {
        vm.warp(schedule.end() - 1);
        twap = 0.85e18;
        _swap(level0, -10e18);
        assertEq(level.totalBurned(), 1.2e18);

        twap = 1e18;
        vm.warp(schedule.end());
        _swap(level0, -10e18);
        assertEq(level.totalBurned(), 1.2e18);
        assertEq(level.balanceOf(TREASURY), 1.199e18);

        vm.warp(schedule.end() - 1 + 7 hours);
        _swap(level0, -10e18);
        assertEq(level.balanceOf(TREASURY), 1.299e18);
    }

    function testExactOutputChargesOneTaxOnLevelInput() public {
        vm.warp(schedule.start());
        twap = 0.85e18;
        uint256 levelBefore = level.balanceOf(address(this));
        uint256 usdcBefore = usdc.balanceOf(address(this));
        _swap(level0, 100e6);
        uint256 paid = levelBefore - level.balanceOf(address(this));
        uint256 burned = level.totalBurned();
        assertEq(usdc.balanceOf(address(this)) - usdcBefore, 100e6);
        assertEq(burned, (paid - burned) * 1200 / 8800);
        assertLe(burned * 10_000, paid * 1200);
        assertEq(level.balanceOf(TREASURY), 0);
    }

    function testPartialSellRevertsWithoutBurn() public {
        vm.warp(schedule.start());
        vm.expectRevert();
        _swap(level0, -900_000e18);
        assertEq(level.totalBurned(), 0);
        assertEq(hook.raisedBps(), 100);
    }

    function _swap(
        bool zeroForOne,
        int256 amount
    ) private returns (BalanceDelta) {
        return swaps.swap(
            key,
            SwapParams(zeroForOne, amount, zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            abi.encode("untrusted router data")
        );
    }
}
