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
import {MockMasonryLevel, MockMasonryUSDC, MockMasonryBurnGuard} from "../unit/MasonryGenesisLPBurnFee.t.sol";
import {MasonryLevelUsdcVault} from "../../src/masonry/MasonryLevelUsdcVault.sol";
import {MasonryGenesisPass} from "../../src/masonry/MasonryGenesisPass.sol";
import {MasonryGenesisStaking, IMasonryGenesisSettlement} from "../../src/masonry/MasonryGenesisStaking.sol";
import {
    MasonryGenesisLPBurnFee,
    IMasonryBurnableLevel,
    IMasonryExactInputV4Router
} from "../../src/masonry/MasonryGenesisLPBurnFee.sol";
import {MiniSwapRouter} from "../../src/swap/MiniSwapRouter.sol";
import {HookMiner} from "../utils/HookMiner.sol";

contract MasonryLevelHookTest is Test, IMasonryLevelTwap {
    MockMasonryLevel private level;
    MockMasonryUSDC private usdc;
    MasonryGenesisSchedule private schedule;
    MasonryLevelHook private hook;
    PoolSwapTest private swaps;
    PoolKey private key;
    bool private level0;
    int24 private center;
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
        center = tick / 60 * 60;
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

    function testVaultTransferredSharesRedeemAndDirectDonationsStayUnallocated() public {
        MasonryLevelUsdcVault vault = _vault();
        uint256 shares = 1e16;
        (uint256 levelIn, uint256 usdcIn) = vault.deposit(shares, type(uint256).max, type(uint256).max, address(this));
        level.transfer(address(vault), 20e18);
        address holder = makeAddr("holder");
        vault.transfer(holder, shares / 2);

        vm.prank(holder);
        (uint256 levelOut, uint256 usdcOut) = vault.redeem(shares / 2, holder);
        assertApproxEqAbs(levelOut, levelIn / 2, 1);
        assertApproxEqAbs(usdcOut, usdcIn / 2, 1);
        assertEq(level.balanceOf(holder), levelOut);
        assertEq(usdc.balanceOf(holder), usdcOut);
        vault.redeem(shares / 2, address(this));
        assertEq(vault.totalSupply(), 0);
        assertEq(level.balanceOf(address(vault)), 20e18);

        vault.deposit(shares, levelIn, usdcIn, address(this));
        vault.redeem(shares, address(this));
        assertEq(level.balanceOf(address(vault)), 20e18);
    }

    function testVaultNewDepositCannotCapturePreviouslyAccruedFees() public {
        MasonryLevelUsdcVault vault = _vault();
        uint256 shares = 1e16;
        vault.deposit(shares, type(uint256).max, type(uint256).max, address(this));
        _swap(!level0, -500e6);

        // Compare the old holder's redemption against an identical branch
        // with a new depositor entering immediately before redemption.
        uint256 checkpoint = vm.snapshotState();
        (uint256 levelExpected, uint256 usdcExpected) = vault.redeem(shares, address(this));
        assertTrue(vm.revertToState(checkpoint));
        address late = makeAddr("late depositor");
        (uint256 levelIn, uint256 usdcIn) = vault.deposit(shares, type(uint256).max, type(uint256).max, late);
        assertGt(level0 ? vault.feeReserve1() : vault.feeReserve0(), 0);
        vm.prank(late);
        (uint256 levelLate, uint256 usdcLate) = vault.redeem(shares, late);
        assertLe(levelLate, levelIn);
        assertLe(usdcLate, usdcIn);
        (uint256 levelOut, uint256 usdcOut) = vault.redeem(shares, address(this));
        assertEq(levelOut, levelExpected);
        assertEq(usdcOut, usdcExpected);
        assertEq(vault.feeReserve0(), 0);
        assertEq(vault.feeReserve1(), 0);
    }

    function testVaultSlippageRevertsWithoutChangingShares() public {
        MasonryLevelUsdcVault vault = _vault();
        vm.expectRevert();
        vault.deposit(1e16, 0, 0, address(this));
        assertEq(vault.totalSupply(), 0);
        vault.deposit(1e16, type(uint256).max, type(uint256).max, address(this));

        vm.expectRevert();
        vault.redeem(1e16, type(uint256).max, 0, address(this));
        assertEq(vault.balanceOf(address(this)), 1e16);
    }

    function testVaultAndCollectorRejectMismatchedPoolKeys() public {
        PoolKey memory wrong = key;
        wrong.fee = 1000;
        int24 lower = center - 6000;
        int24 upper = center + 6000;
        vm.expectRevert(MasonryLevelUsdcVault.InvalidConfiguration.selector);
        new MasonryLevelUsdcVault(wrong, lower, upper);

        MasonryLevelUsdcVault vault = _vault();
        MockMasonryBurnGuard guard = new MockMasonryBurnGuard();
        MiniSwapRouter router = new MiniSwapRouter(hook.poolManager());
        vm.expectRevert(MasonryGenesisLPBurnFee.InvalidPool.selector);
        new MasonryGenesisLPBurnFee(
            vault,
            IMasonryBurnableLevel(address(level)),
            usdc,
            IMasonryExactInputV4Router(address(router)),
            guard,
            wrong,
            address(this),
            1e16,
            10_000e6
        );
    }

    function testGenesisDepositRedeemsRealVaultFeeAndRetriesUsdcBuyback() public {
        MasonryLevelUsdcVault vault = _vault();
        MockMasonryBurnGuard guard = new MockMasonryBurnGuard();
        guard.setSafe(false);
        MasonryGenesisLPBurnFee collector = new MasonryGenesisLPBurnFee(
            vault,
            IMasonryBurnableLevel(address(level)),
            usdc,
            IMasonryExactInputV4Router(address(new MiniSwapRouter(hook.poolManager()))),
            guard,
            key,
            address(this),
            1e16,
            10_000e6
        );
        MasonryGenesisPass pass = new MasonryGenesisPass(usdc, TREASURY, schedule);
        MasonryGenesisStaking staking =
            new MasonryGenesisStaking(pass, collector, IMasonryGenesisSettlement(address(this)), usdc, 7000e18);
        collector.setGenesis(address(staking));
        level.approve(address(staking), 7000e18);
        staking.fund();

        address member = makeAddr("genesis member");
        usdc.mint(member, 50e6);
        vm.startPrank(member);
        usdc.approve(address(pass), 50e6);
        pass.purchase(MasonryGenesisPass.Tier.Genesis);
        vault.approve(address(staking), type(uint256).max);
        vm.stopPrank();

        uint256 gross = 1e16;
        vault.deposit(gross * 2, type(uint256).max, type(uint256).max, member);
        vm.warp(schedule.lpOpens());
        vm.prank(member);
        staking.deposit(1, gross);

        uint256 firstBurn = level.totalBurned();
        assertGt(firstBurn, 0);
        assertEq(firstBurn, collector.totalLevelBurnedFromLPFees());
        assertGt(collector.pendingBurnUSDC(), 0);
        assertEq(collector.pendingFeeShares(), 0);

        guard.setSafe(true);
        vm.prank(member);
        staking.deposit(1, gross);
        assertEq(collector.pendingBurnUSDC(), 0);
        assertEq(collector.totalFeeSharesCollected(), gross / 100);
        assertGt(level.totalBurned(), firstBurn);
        assertEq(level.totalBurned(), collector.totalLevelBurnedFromLPFees());
        assertEq(hook.genesisLevelBurned(), 0);
        (uint256 shares,,) = staking.positions(1, member);
        assertEq(shares, gross * 2 - gross / 100);
        assertEq(vault.balanceOf(address(staking)), shares);
    }

    function _vault() private returns (MasonryLevelUsdcVault vault) {
        vault = new MasonryLevelUsdcVault(key, center - 6000, center + 6000);
        level.approve(address(vault), type(uint256).max);
        usdc.approve(address(vault), type(uint256).max);
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
