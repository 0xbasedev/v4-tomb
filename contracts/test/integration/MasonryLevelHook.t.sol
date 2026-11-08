// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {SqrtPriceMath} from "v4-core/src/libraries/SqrtPriceMath.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {MasonryRangeManager} from "../../src/masonry/MasonryRangeManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {LiquidityAmounts} from "v4-periphery/src/libraries/LiquidityAmounts.sol";
import {MasonryCriticalDefense} from "../../src/masonry/MasonryCriticalDefense.sol";
import {MasonryLevelOracle} from "../../src/masonry/MasonryLevelOracle.sol";
import {MasonryTaxHook} from "../../src/hooks/MasonryTaxHook.sol";
import {MasonrySquareHook} from "../../src/hooks/MasonrySquareHook.sol";
import {MasonryGenesisSettlement} from "../../src/masonry/MasonryGenesisSettlement.sol";
import {MasonryLevelHook} from "../../src/hooks/MasonryLevelHook.sol";
import {MasonryGenesisSchedule} from "../../src/masonry/MasonryGenesisSchedule.sol";
import {MockMasonryLevel, MockMasonryUSDC, MockMasonryBurnGuard} from "../unit/MasonryGenesisLPBurnFee.t.sol";
import {MasonryBuybackGuard} from "../../src/masonry/MasonryBuybackGuard.sol";
import {MasonrySquareUsdcVault} from "../../src/masonry/MasonrySquareUsdcVault.sol";
import {IMasonryPolSink} from "../../src/masonry/IMasonryPolSink.sol";
import {MasonryLevelUsdcVault, MasonryUsdcVault} from "../../src/masonry/MasonryLevelUsdcVault.sol";
import {MasonryGenesisPass} from "../../src/masonry/MasonryGenesisPass.sol";
import {MasonryGenesisStaking, IMasonryGenesisSettlement} from "../../src/masonry/MasonryGenesisStaking.sol";
import {
    MasonryGenesisLPBurnFee,
    IMasonryBurnableLevel,
    IMasonryExactInputV4Router
} from "../../src/masonry/MasonryGenesisLPBurnFee.sol";
import {MiniSwapRouter} from "../../src/swap/MiniSwapRouter.sol";
import {HookMiner} from "../utils/HookMiner.sol";
import {MasonryLevelPrice} from "../../src/masonry/MasonryLevelPrice.sol";

interface IMockLevelTwap {
    function mockTwapSettings() external view returns (uint256 price, bool enabled);
}

contract MockTwapLevelHook is MasonryLevelHook {
    constructor(
        IPoolManager manager,
        MasonryGenesisSchedule schedule,
        OracleConfig memory oracleConfig,
        address level,
        address usdc,
        address recipient,
        uint24 fee,
        int24 spacing
    ) MasonryLevelHook(manager, schedule, oracleConfig, level, usdc, recipient, fee, spacing) {}

    function _validatedTwap() internal view override returns (uint256) {
        (uint256 price, bool enabled) = IMockLevelTwap(testHarness).mockTwapSettings();
        return enabled ? price : super._validatedTwap();
    }

    address private immutable testHarness = msg.sender;
}

/// Impersonates a range manager: answers every bind check with the real hook's values.
contract FakeRangeManager {
    address public hook;
    bytes32 private pid;
    address public manager;

    constructor(address hook_, bytes32 pid_, address manager_) {
        hook = hook_;
        pid = pid_;
        manager = manager_;
    }

    function poolId() external view returns (bytes32) {
        return pid;
    }
}

contract MasonryLevelHookTest is Test, ERC721Holder, IMockLevelTwap {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;
    MockMasonryLevel private level;
    MockMasonryUSDC private usdc;
    MasonryGenesisSchedule private schedule;
    MasonryLevelHook private hook;
    PoolSwapTest private swaps;
    PoolModifyLiquidityTest private liquidity;
    PoolKey private key;
    bool private level0;
    int24 private center;
    uint256 private twap = 1e18;
    bool private mockTwap = true;
    address private constant TREASURY = address(0x777);

    function mockTwapSettings() external view returns (uint256, bool) {
        return (twap, mockTwap);
    }

    function setUp() public {
        _setUpPool(block.timestamp + 1 days);
    }

    function _setUpPool(
        uint256 genesisStart
    ) private {
        level = new MockMasonryLevel();
        usdc = new MockMasonryUSDC();
        schedule = new MasonryGenesisSchedule(genesisStart, address(this));
        PoolManager manager = new PoolManager(address(this));
        swaps = new PoolSwapTest(manager);
        liquidity = new PoolModifyLiquidityTest(manager);
        uint160 flags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG
            | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG;
        MasonryTaxHook.OracleConfig memory oracleConfig = _nextOracle();
        bytes memory args = abi.encode(manager, schedule, oracleConfig, level, usdc, TREASURY, uint24(3000), int24(60));
        (address expected, bytes32 salt) =
            HookMiner.find(address(this), flags, bytes.concat(type(MockTwapLevelHook).creationCode, args));
        key = _deployOracle(oracleConfig, expected, address(level));
        hook = new MockTwapLevelHook{salt: salt}(
            manager, schedule, oracleConfig, address(level), address(usdc), TREASURY, 3000, 60
        );
        level0 = address(level) < address(usdc);
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

    /// Aggressive curve e2e: TWAP is at peg (no floor), but a large sell whose
    /// projected post-sale price is >=10% below peg is charged the full 12%.
    function testXTombSellPaysNoTaxEvenWhenTheSaleDepegs() public {
        vm.warp(schedule.end() + 1);
        twap = 1e18;
        uint256 treasuryBefore = level.balanceOf(TREASURY);
        uint256 burnedBefore = level.totalBurned();
        _swap(level0, -1100e18);
        (uint160 sqrtAfter,,,) = hook.poolManager().getSlot0(hook.officialPool());
        assertLe(MasonryLevelPrice.fromSqrtPrice(sqrtAfter, level0), 0.9e18, "sale lands >=10% below peg");
        assertEq(level.balanceOf(TREASURY), treasuryBefore, "no X Tomb sell tax");
        assertEq(level.totalBurned(), burnedBefore);
        assertEq(hook.genesisLevelBurned(), 0);
    }

    function testXTombSellsStayUntaxedBeforeDuringAndAfterGenesis() public {
        vm.warp(schedule.start() - 1);
        _swap(level0, -10e18);
        assertEq(level.balanceOf(TREASURY), 0);
        assertEq(level.totalBurned(), 0);

        vm.warp(schedule.start());
        uint256 before = level.balanceOf(address(this));
        _swap(level0, -10e18);
        assertEq(before - level.balanceOf(address(this)), 10e18);
        assertEq(level.totalBurned(), 0);
        assertEq(hook.genesisLevelBurned(), 0);
        assertEq(level.balanceOf(TREASURY), 0);

        vm.warp(schedule.end() - 1);
        _swap(level0, -10e18);
        assertEq(level.totalBurned(), 0);

        vm.warp(schedule.end());
        _swap(level0, -10e18);
        assertEq(level.totalBurned(), 0);
        assertEq(level.balanceOf(TREASURY), 0);
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

    function testWithdrawFeeUsesTwapFireTaxAndSevenHourDecay() public {
        vm.warp(schedule.end() + 1);
        twap = 1e18;
        hook.checkpoint();
        assertEq(hook.currentWithdrawFeeBps(), 300);

        twap = 0.9e18;
        assertEq(hook.syncWithdrawFeeBps(), 1200);
        assertEq(hook.raisedBps(), 1200);

        twap = 1e18;
        assertEq(hook.currentWithdrawFeeBps(), 1200);
        vm.warp(block.timestamp + 3.5 hours);
        assertEq(hook.currentWithdrawFeeBps(), 750);
        vm.warp(block.timestamp + 3.5 hours);
        assertEq(hook.currentWithdrawFeeBps(), 300);
    }

    function testOrdinaryRecoveryNoLongerTaxesXTombSells() public {
        vm.warp(schedule.end() - 1);
        twap = 0.85e18;
        _swap(level0, -10e18);
        assertEq(level.totalBurned(), 0);
        assertEq(hook.syncWithdrawFeeBps(), 1200);

        twap = 1e18;
        vm.warp(schedule.end());
        _swap(level0, -10e18);
        assertEq(level.totalBurned(), 0);
        assertEq(level.balanceOf(TREASURY), 0);
        assertGt(hook.currentWithdrawFeeBps(), 300);

        vm.warp(schedule.end() - 1 + 7 hours);
        _swap(level0, -10e18);
        assertEq(level.balanceOf(TREASURY), 0);
        assertEq(hook.currentWithdrawFeeBps(), 300);
    }

    function testExactOutputXTombSellPaysNoTax() public {
        vm.warp(schedule.start());
        twap = 0.85e18;
        uint256 levelBefore = level.balanceOf(address(this));
        uint256 usdcBefore = usdc.balanceOf(address(this));
        _swap(level0, 100e6);
        uint256 paid = levelBefore - level.balanceOf(address(this));
        assertEq(usdc.balanceOf(address(this)) - usdcBefore, 100e6);
        assertEq(level.totalBurned(), 0);
        assertEq(level.balanceOf(TREASURY), 0);
        assertGt(paid, 100e6); // still pays X Tomb for 100 USDG out, plus LP impact
    }

    function testPartialSellNoLongerBurns() public {
        vm.warp(schedule.start());
        _swap(level0, -900_000e18);
        assertEq(level.totalBurned(), 0);
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
        vm.expectRevert(MasonryUsdcVault.InvalidConfiguration.selector);
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
            10_000e6,
            address(this)
        );
    }

    function testCollectorRejectsMismatchedGuardPool() public {
        MasonryLevelUsdcVault vault = _vault();
        MockMasonryBurnGuard guard = new MockMasonryBurnGuard();
        PoolKey memory wrong = key;
        wrong.fee = 1000;
        guard.setPoolKey(wrong);
        MiniSwapRouter router = new MiniSwapRouter(hook.poolManager());

        vm.expectRevert(MasonryGenesisLPBurnFee.InvalidPool.selector);
        new MasonryGenesisLPBurnFee(
            vault,
            IMasonryBurnableLevel(address(level)),
            usdc,
            IMasonryExactInputV4Router(address(router)),
            guard,
            key,
            address(this),
            1e16,
            10_000e6,
            address(this)
        );
    }

    function testGenesisDepositRedeemsRealVaultFeeAndRetriesUsdcBuyback() public {
        MasonryLevelUsdcVault vault = _vault();
        MasonryBuybackGuard guard = new MasonryBuybackGuard(key, 150, 100, 150);
        MasonryGenesisLPBurnFee collector = new MasonryGenesisLPBurnFee(
            vault,
            IMasonryBurnableLevel(address(level)),
            usdc,
            IMasonryExactInputV4Router(address(new MiniSwapRouter(hook.poolManager()))),
            guard,
            key,
            address(this),
            1e16,
            10_000e6,
            address(this)
        );
        MasonryGenesisPass pass = new MasonryGenesisPass(usdc, TREASURY, schedule);
        pass.setSaleOpen(true);
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
        vm.warp(schedule.lpOpens() - 30 minutes);
        hook.checkpoint();
        vm.warp(schedule.lpOpens());
        vm.prank(member);
        staking.deposit(1, gross);

        uint256 firstBurn = level.totalBurned();
        assertGt(firstBurn, 0);
        assertEq(firstBurn, collector.totalLevelBurnedFromLPFees());
        assertGt(collector.pendingBurnUSDC(), 0);
        assertEq(collector.pendingFeeShares(), 0);

        _swap(!level0, -1e6);
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

    function testOracleWarmupSellAndSameTimestampPriceMove() public {
        mockTwap = false;
        _swap(!level0, -1e6);
        (,, bool valid) = hook.oracle().latestValidatedTwap();
        assertFalse(valid);

        vm.warp(schedule.start() - 30 minutes);
        _warmOracle();
        (uint256 beforePrice,, bool ready) = hook.oracle().latestValidatedTwap();
        assertTrue(ready);
        assertApproxEqAbs(beforePrice, 1e18, 0.0002e18);
        _swap(level0, -10e18);
        assertEq(level.totalBurned(), 0);

        _swap(!level0, -1000e6);
        (uint256 afterPrice, uint256 observedAt, bool stillReady) = hook.oracle().latestValidatedTwap();
        assertTrue(stillReady);
        assertEq(afterPrice, beforePrice);
        assertEq(observedAt, block.timestamp);

        vm.warp(observedAt + 30 minutes + 1);
        hook.checkpoint();
        (,, valid) = hook.oracle().latestValidatedTwap();
        assertFalse(valid);
        assertEq(hook.oracle().lastPriceChange(), observedAt);
    }

    function testOracleRejectsWindowContainingThinLiquidity() public {
        vm.warp(schedule.start());
        hook.checkpoint();
        vm.warp(schedule.start() + 10 minutes);
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(center - 6000, center + 6000, -1e16, 0), "");
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(center - 120, center + 120, -1e16, 0), "");
        vm.warp(schedule.start() + 11 minutes);
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(center - 6000, center + 6000, 1e16, 0), "");
        vm.warp(schedule.start() + 30 minutes);
        _swap(!level0, -1e6);
        (,, bool valid) = hook.oracle().latestValidatedTwap();
        assertFalse(valid);

        vm.warp(schedule.start() + 41 minutes);
        _swap(!level0, -1e6);
        (,, valid) = hook.oracle().latestValidatedTwap();
        assertTrue(valid);
    }

    function testBuybackPreviewDoesNotMovePoolOrRefreshOracle() public {
        vm.warp(schedule.start());
        _warmOracle();
        MasonryBuybackGuard guard = new MasonryBuybackGuard(key, 150, 100, 150);
        vm.warp(schedule.start() + 31 minutes);
        (uint160 sqrtBefore,,,) = hook.poolManager().getSlot0(hook.officialPool());
        uint256 lastPriceChange = hook.oracle().lastPriceChange();
        uint256 quoted = guard.minimumLevelOut(10e6);
        (uint160 sqrtAfter,,,) = hook.poolManager().getSlot0(hook.officialPool());
        assertEq(sqrtAfter, sqrtBefore);
        assertEq(hook.oracle().lastPriceChange(), lastPriceChange);

        uint256 levelBefore = level.balanceOf(address(this));
        _swap(!level0, -10e6);
        assertEq(level.balanceOf(address(this)) - levelBefore, quoted);
    }

    function testBuybackGuardRejectsExcessiveImpactAndSpotDeviation() public {
        vm.warp(schedule.start());
        _warmOracle();
        MasonryBuybackGuard guard = new MasonryBuybackGuard(key, 150, 100, 150);
        vm.expectRevert(MasonryBuybackGuard.UnsafePrice.selector);
        guard.minimumLevelOut(500e6);
        _swap(!level0, -1000e6);
        vm.expectRevert(MasonryBuybackGuard.UnsafePrice.selector);
        guard.minimumLevelOut(1e6);
    }

    function testBuybackPreviewMatchesExecutionAcrossInitializedTick() public {
        vm.warp(schedule.start());
        _warmOracle();
        MasonryBuybackGuard guard = new MasonryBuybackGuard(key, 300, 300, 300);
        IPoolManager manager = hook.poolManager();
        (uint160 sqrtBefore,,,) = manager.getSlot0(hook.officialPool());
        uint128 liquidityBefore = manager.getLiquidity(hook.officialPool());
        uint160 nextBoundary = TickMath.getSqrtPriceAtTick(level0 ? center + 120 : center - 120);
        uint256 netInput = level0
            ? SqrtPriceMath.getAmount1Delta(sqrtBefore, nextBoundary, liquidityBefore, true)
            : SqrtPriceMath.getAmount0Delta(nextBoundary, sqrtBefore, liquidityBefore, true);
        uint256 usdcInput = netInput * 1000 / 997 + 1e6;
        uint256 quote = guard.minimumLevelOut(usdcInput);
        assertEq(manager.getLiquidity(hook.officialPool()), liquidityBefore);

        uint256 levelBefore = level.balanceOf(address(this));
        _swap(!level0, -int256(usdcInput));
        assertLt(manager.getLiquidity(hook.officialPool()), liquidityBefore);
        assertEq(level.balanceOf(address(this)) - levelBefore, quote);
    }

    function testBuybackGuardRejectsTwapExecutionLossWithinImpactLimit() public {
        vm.warp(schedule.start());
        _warmOracle();
        // A 0.01% execution tolerance is smaller than the pool's 0.3% LP fee.
        MasonryBuybackGuard guard = new MasonryBuybackGuard(key, 150, 100, 1);
        vm.expectRevert(MasonryBuybackGuard.UnsafePrice.selector);
        guard.minimumLevelOut(1e6);
    }

    function testRealGenesisClaimEscrowsHalfAndReleasesOneInstallment() public {
        _assertGenesisClaimAndRelease();
    }

    function testDeferredGenesisSettlementUsesTheDateSetAfterDeployment() public {
        _setUpPool(0);
        _assertGenesisClaimAndRelease();
    }

    function _assertGenesisClaimAndRelease() private {
        (MasonryGenesisStaking staking, MasonryGenesisSettlement settlement,) = _realGenesis();
        vm.warp(schedule.lpOpens());
        uint256 levelBefore = level.balanceOf(address(this));
        staking.claim(0);
        assertEq(level.balanceOf(address(this)) - levelBefore, 4.9e18);
        assertEq(level.balanceOf(TREASURY), 0.1e18);
        assertEq(settlement.totalEscrowed(), 5e18);
        assertEq(settlement.trancheCount(address(this)), 1);

        vm.expectRevert(MasonryGenesisStaking.Cooldown.selector);
        staking.claim(0);
        vm.warp(schedule.end() + 6 hours - 1);
        vm.expectRevert(MasonryGenesisSettlement.VestingLocked.selector);
        settlement.release(0);
        vm.warp(schedule.end() + 6 hours);
        assertEq(settlement.release(0), 0.3125e18);
        assertEq(settlement.totalEscrowed(), 4.6875e18);
        vm.expectRevert(MasonryGenesisSettlement.VestingLocked.selector);
        settlement.release(0);
        assertEq(level.balanceOf(address(settlement)), settlement.totalEscrowed());
    }

    function testRealKeeperCompoundUsesLiquidHalfAndOneLpFee() public {
        (MasonryGenesisStaking staking, MasonryGenesisSettlement settlement, MasonryGenesisLPBurnFee collector) =
            _realGenesis();
        address keeper = makeAddr("keeper");
        staking.setKeeper(keeper, 1);
        vm.warp(schedule.lpOpens() - 30 minutes);
        _warmOracle();
        mockTwap = false;
        uint256 swapLevel = 2.45e18;
        uint256 gross = _estimateShares(settlement.vault(), 4.9e18, swapLevel);
        IMasonryGenesisSettlement.CompoundPlan memory plan = IMasonryGenesisSettlement.CompoundPlan(swapLevel, gross);

        vm.prank(keeper);
        vm.expectRevert(MasonryGenesisStaking.InvalidAmount.selector);
        staking.compoundToLP(0, address(this), gross, plan);
        assertEq(settlement.totalEscrowed(), 0);
        assertEq(level.totalBurned(), 0);

        vm.prank(keeper);
        staking.compoundToLP(0, address(this), 1, plan);
        (uint256 net,,) = staking.positions(1, address(this));
        assertEq(net, gross - gross * 50 / 10_000);
        assertEq(collector.totalFeeSharesCollected(), gross - net);
        assertEq(settlement.totalEscrowed(), 5e18);
        assertGe(level.balanceOf(TREASURY), 0.1e18);
        assertEq(hook.genesisLevelBurned(), 0);
        assertGt(collector.totalLevelBurnedFromLPFees(), 0);
        assertEq(level.balanceOf(keeper), 0);

        vm.expectRevert(MasonryGenesisStaking.Cooldown.selector);
        staking.claim(0);
    }

    function testRealManualCompoundChargesNoPerformanceFee() public {
        (MasonryGenesisStaking staking, MasonryGenesisSettlement settlement, MasonryGenesisLPBurnFee collector) =
            _realGenesis();
        vm.warp(schedule.lpOpens() - 30 minutes);
        _warmOracle();
        mockTwap = false;
        uint256 swapLevel = 2.5e18;
        uint256 gross = _estimateShares(settlement.vault(), 5e18, swapLevel);
        staking.compoundToLP(0, address(this), 1, IMasonryGenesisSettlement.CompoundPlan(swapLevel, gross));
        assertEq(settlement.totalEscrowed(), 5e18);
        assertEq(collector.totalFeeSharesCollected(), gross * 50 / 10_000);
        // Only the small wallet refund can incur a claim fee.
        assertLt(level.balanceOf(TREASURY), 0.003e18);
    }

    function testShareSellTaxIsFlatThreePercentBuysUntaxedAndBuyAndBurnCutsXTomb() public {
        (MasonrySquareHook squareHook, MockMasonryLevel square, PoolKey memory squareKey) = _squarePool();
        assertEq(squareHook.shareSellTaxBps(), 300);
        vm.warp(schedule.start());
        hook.checkpoint();
        squareHook.checkpoint();
        vm.warp(schedule.start() + 30 minutes);
        _swap(!level0, -1e6);
        _swapOn(squareKey, !squareHook.assetIsCurrency0(), -1e6);
        assertEq(squareHook.pendingBuybackSquare(), 0, "buys are not taxed");

        uint256 sold = 100e18;
        _swapOn(squareKey, squareHook.assetIsCurrency0(), -int256(sold));
        assertEq(squareHook.pendingBuybackSquare(), sold * 300 / 10_000);
        assertEq(squareHook.polSquare(), 0);
        assertEq(squareHook.retainedSquare(), 0);
        assertEq(level.totalBurned(), 0);

        uint256 burnedBefore = level.totalBurned();
        squareHook.buyAndBurn();
        assertEq(squareHook.pendingBuybackSquare(), 0);
        assertGt(squareHook.levelBurned(), 0);
        assertEq(level.totalBurned() - burnedBefore, squareHook.levelBurned());
    }

    function testSquarePolVaultMintsRedeemableSharesToTreasury() public {
        (MasonrySquareHook squareHook, MockMasonryLevel square, PoolKey memory squareKey) = _squarePool();
        (, int24 tick,,) = hook.poolManager().getSlot0(squareHook.officialPool());
        int24 midpoint = tick / 60 * 60;
        MasonrySquareUsdcVault pol = new MasonrySquareUsdcVault(squareKey, midpoint - 6000, midpoint + 6000);
        vm.prank(makeAddr("not deployer"));
        vm.expectRevert(MasonryTaxHook.InvalidConfiguration.selector);
        squareHook.bindPolVault(IMasonryPolSink(address(pol)));
        squareHook.bindPolVault(IMasonryPolSink(address(pol)));

        vm.warp(schedule.start());
        squareHook.checkpoint();
        vm.warp(schedule.start() + 30 minutes);
        bool square0 = squareHook.assetIsCurrency0();
        _swapOn(squareKey, !square0, -1e6);
        _swapOn(squareKey, square0, -100e18);
        assertEq(pol.balanceOf(TREASURY), 0, "sell tax no longer auto-funds POL");
        assertEq(squareHook.pendingBuybackSquare(), 3e18);
        assertEq(squareHook.polSquare(), 0);
    }

    function testSquarePrepaidRouterPreservesSettlementAndAccruesBuyback() public {
        (MasonrySquareHook squareHook, MockMasonryLevel square, PoolKey memory squareKey) = _squarePool();
        vm.warp(schedule.start());
        squareHook.checkpoint();
        vm.warp(schedule.start() + 30 minutes);
        bool square0 = squareHook.assetIsCurrency0();
        _swapOn(squareKey, !square0, -1e6);

        uint256 before = square.balanceOf(address(this));
        hook.poolManager().unlock(abi.encode(squareKey, square0, uint256(100e18)));
        assertEq(before - square.balanceOf(address(this)), 100e18);
        assertEq(squareHook.deferredSquareClaims(), 3e18);
        assertEq(squareHook.pendingBuybackSquare(), 3e18);
        assertEq(hook.poolManager().balanceOf(TREASURY, Currency.wrap(address(square)).toId()), 0);
    }

    // A router that transfers its ERC20 input before calling swap and settles
    // afterward. SQUARE fees must not alter its synced reserve snapshot.
    function unlockCallback(
        bytes calldata data
    ) external returns (bytes memory) {
        assertEq(msg.sender, address(hook.poolManager()));
        (PoolKey memory pool, bool zeroForOne, uint256 amount) = abi.decode(data, (PoolKey, bool, uint256));
        IPoolManager manager = IPoolManager(msg.sender);
        Currency input = zeroForOne ? pool.currency0 : pool.currency1;
        Currency output = zeroForOne ? pool.currency1 : pool.currency0;
        manager.sync(input);
        MockMasonryLevel(Currency.unwrap(input)).transfer(address(manager), amount);
        BalanceDelta delta = manager.swap(
            pool,
            SwapParams(
                zeroForOne, -int256(amount), zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            ""
        );
        assertEq(manager.settle(), amount);
        int128 received = zeroForOne ? delta.amount1() : delta.amount0();
        manager.take(output, address(this), uint256(uint128(received)));
        return "";
    }

    function testOracleRingRemainsValidAfterCheckpointChurn() public {
        vm.warp(schedule.start());
        uint256 start = block.timestamp;
        hook.checkpoint();
        for (uint256 i = 1; i <= 24; ++i) {
            vm.warp(start + i * 5 minutes);
            hook.checkpoint();
            hook.checkpoint();
        }
        _swap(!level0, -1e6);
        (uint256 price,, bool valid) = hook.oracle().latestValidatedTwap();
        assertTrue(valid);
        assertApproxEqAbs(price, 1e18, 0.0002e18);
    }

    function testSquareUnsafeConversionDefersWithoutBlockingSell() public {
        (MasonrySquareHook squareHook, MockMasonryLevel square, PoolKey memory squareKey) = _squarePool();
        vm.warp(schedule.start());
        squareHook.checkpoint();
        vm.warp(schedule.start() + 30 minutes);
        _swapOn(squareKey, !squareHook.assetIsCurrency0(), -1e6);
        // This user trade is valid but leaves spot outside the optional route's guard.
        uint256 before = square.balanceOf(address(this));
        _swapOn(squareKey, squareHook.assetIsCurrency0(), -1000e18);
        assertEq(before - square.balanceOf(address(this)), 1000e18);
        assertEq(squareHook.pendingBuybackSquare(), 30e18);
        assertEq(squareHook.usdcRouted(), 0);
        assertEq(square.balanceOf(address(squareHook)), squareHook.pendingBuybackSquare());
    }

    function _realGenesis()
        private
        returns (MasonryGenesisStaking staking, MasonryGenesisSettlement settlement, MasonryGenesisLPBurnFee collector)
    {
        MasonryLevelUsdcVault vault = _vault();
        MasonryBuybackGuard guard = new MasonryBuybackGuard(key, 150, 100, 150);
        MiniSwapRouter router = new MiniSwapRouter(hook.poolManager());
        collector = new MasonryGenesisLPBurnFee(
            vault,
            IMasonryBurnableLevel(address(level)),
            usdc,
            IMasonryExactInputV4Router(address(router)),
            guard,
            key,
            address(this),
            1e16,
            10_000e6,
            address(this)
        );
        MasonryGenesisPass pass = new MasonryGenesisPass(usdc, TREASURY, schedule);
        pass.setSaleOpen(true);
        settlement = new MasonryGenesisSettlement(vault, guard, router, TREASURY, address(this));
        staking = new MasonryGenesisStaking(pass, collector, settlement, usdc, 70e18);
        collector.setGenesis(address(staking));
        settlement.bind(staking);
        level.approve(address(staking), 70e18);
        staking.fund();
        if (schedule.start() == 0) {
            assertEq(settlement.genesisEnd(), 0);
            schedule.schedule(block.timestamp + 1 days);
        }
        assertEq(settlement.genesisEnd(), schedule.end());
        usdc.approve(address(pass), 100e6);
        pass.purchase(MasonryGenesisPass.Tier.Pro);
        usdc.approve(address(staking), 100e6);
        vm.warp(schedule.start());
        staking.deposit(0, 100e6);
    }

    function _estimateShares(
        MasonryLevelUsdcVault vault,
        uint256 budget,
        uint256 swapLevel
    ) private returns (uint256 shares) {
        uint256 snapshot = vm.snapshotState();
        uint256 usdcBefore = usdc.balanceOf(address(this));
        _swap(level0, -int256(swapLevel));
        uint256 usdcAvailable = usdc.balanceOf(address(this)) - usdcBefore;
        (uint160 sqrtPrice,,,) = hook.poolManager().getSlot0(hook.officialPool());
        uint256 levelAvailable = budget - swapLevel;
        shares = LiquidityAmounts.getLiquidityForAmounts(
            sqrtPrice,
            TickMath.getSqrtPriceAtTick(vault.tickLower()),
            TickMath.getSqrtPriceAtTick(vault.tickUpper()),
            level0 ? levelAvailable : usdcAvailable,
            level0 ? usdcAvailable : levelAvailable
        );
        assertTrue(vm.revertToState(snapshot));
    }

    function _nextOracle() private view returns (MasonryTaxHook.OracleConfig memory) {
        address expected = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        return MasonryTaxHook.OracleConfig(MasonryLevelOracle(expected), address(this));
    }

    function _deployOracle(
        MasonryTaxHook.OracleConfig memory config,
        address hookAddress,
        address token
    ) private returns (PoolKey memory pool) {
        bool token0 = token < address(usdc);
        pool = PoolKey(
            Currency.wrap(token0 ? token : address(usdc)),
            Currency.wrap(token0 ? address(usdc) : token),
            3000,
            60,
            IHooks(hookAddress)
        );
        assertEq(address(new MasonryLevelOracle(pool.toId(), token0, 1e15, hookAddress)), address(config.oracle));
    }

    function _squarePool()
        private
        returns (MasonrySquareHook squareHook, MockMasonryLevel square, PoolKey memory squareKey)
    {
        square = new MockMasonryLevel();
        MasonryCriticalDefense defense = new MasonryCriticalDefense(hook.oracle());
        MasonrySquareHook.RoutingConfig memory config =
            MasonrySquareHook.RoutingConfig(key, TREASURY, address(this), 1e18, 100e18, 300, defense, 300);
        IPoolManager manager = hook.poolManager();
        uint160 flags = uint160(address(hook)) & HookMiner.FLAG_MASK;
        MasonryTaxHook.OracleConfig memory oracleConfig = _nextOracle();
        bytes memory args = abi.encode(manager, oracleConfig, square, usdc, uint24(3000), int24(60), config);
        (address expected, bytes32 salt) =
            HookMiner.find(address(this), flags, bytes.concat(type(MasonrySquareHook).creationCode, args));
        squareKey = _deployOracle(oracleConfig, expected, address(square));
        squareHook =
            new MasonrySquareHook{salt: salt}(manager, oracleConfig, address(square), address(usdc), 3000, 60, config);
        bool square0 = squareHook.assetIsCurrency0();
        uint160 peg = uint160(square0 ? (uint256(1) << 96) / 1e6 : (uint256(1) << 96) * 1e6);
        manager.initialize(squareKey, peg);
        square.mint(address(this), 1_000_000e18);
        square.approve(address(liquidity), type(uint256).max);
        square.approve(address(swaps), type(uint256).max);
        int24 midpoint = TickMath.getTickAtSqrtPrice(peg) / 60 * 60;
        liquidity.modifyLiquidity(squareKey, ModifyLiquidityParams(midpoint - 6000, midpoint + 6000, 1e16, 0), "");
    }

    function _warmOracle() private {
        uint256 start = block.timestamp;
        hook.checkpoint();
        vm.warp(start + 30 minutes);
        _swap(!level0, -1e6);
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
        return _swapOn(key, zeroForOne, amount);
    }

    function _swapOn(
        PoolKey memory pool,
        bool zeroForOne,
        int256 amount
    ) private returns (BalanceDelta) {
        return swaps.swap(
            pool,
            SwapParams(zeroForOne, amount, zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            abi.encode("untrusted router data")
        );
    }

    /// Measured deduction breakdown on the official xTOMB/USDG pool (fee 3000, tax ceiling untouched).
    /// Spot is moved to the target with a price-limited sell, TWAP is set to match, then a
    /// 10 xTOMB sell is measured: Fire Tax = treasury delta; LP fee = feeGrowthGlobal delta * L;
    /// total = 1 - (USDG out / no-deduction spot value), all in bps of input.
    function testMeasuredSellDeductionsAtPegNinetyAndSeventy() public {
        vm.warp(schedule.end() + 1);
        uint256[3] memory targets = [uint256(1e18), 0.9e18, 0.7e18];
        for (uint256 i; i < 3; ++i) {
            uint256 snap = vm.snapshotState();
            _measure(targets[i]);
            vm.revertToState(snap);
        }
    }

    struct M { uint256 spot; uint256 liq; uint256 fg; uint256 tax; uint256 out; uint256 lpFee; }

    function _measure(uint256 target) private {
        IPoolManager manager = hook.poolManager();
        if (target < 1e18) {
            for (uint256 n; n < 2000; ++n) {
                (uint160 sp,,,) = manager.getSlot0(key.toId());
                if (MasonryLevelPrice.fromSqrtPrice(sp, level0) <= target) break;
                _swap(level0, -20e18);
            }
        }
        twap = target;
        M memory m;
        (uint160 sqrtP,,,) = manager.getSlot0(key.toId());
        m.spot = MasonryLevelPrice.fromSqrtPrice(sqrtP, level0);
        m.liq = manager.getLiquidity(key.toId());
        m.fg = _fg(manager);
        m.tax = level.balanceOf(TREASURY);
        m.out = usdc.balanceOf(address(this));
        _swap(level0, -int256(10e18));
        m.tax = level.balanceOf(TREASURY) - m.tax;
        m.out = usdc.balanceOf(address(this)) - m.out;
        m.lpFee = (_fg(manager) - m.fg) * m.liq / (1 << 128);
        uint256 ideal = 10e18 * m.spot / 1e18 / 1e12;
        uint256 totalBps = (ideal - m.out) * 10_000 / ideal;
        emit log_named_uint("RAW in_xTOMB_wei", 10e18);
        emit log_named_uint("RAW spot_1e18", m.spot);
        emit log_named_uint("RAW in_value_usdg_6dp", ideal);
        emit log_named_uint("RAW tax_xTOMB_wei", m.tax);
        emit log_named_uint("RAW to_pool_xTOMB_wei", 10e18 - m.tax);
        emit log_named_uint("RAW lpfee_xTOMB_wei", m.lpFee);
        emit log_named_uint("RAW out_usdg_6dp", m.out);
        emit log_named_uint("RAW noimpact_out_usdg_6dp", (10e18 - m.tax - m.lpFee) * m.spot / 1e18 / 1e12);
        emit log_named_uint("target price (1e18)", target);
        emit log_named_uint("  spot before (1e18)", m.spot);
        emit log_named_uint("  fire tax bps of input", m.tax * 1000 / 1e18);
        emit log_named_uint("  LP fee bps of input", m.lpFee * 1000 / 1e18);
        emit log_named_uint("  total deduction bps (vs pre-trade spot)", totalBps);
    }

    function _fg(IPoolManager manager) private view returns (uint256) {
        (uint256 a, uint256 b) = manager.getFeeGrowthGlobals(key.toId());
        return level0 ? a : b;
    }

    function _sqrt(uint256 x) private pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2; y = x;
        while (z < y) { y = z; z = (x / z + z) / 2; }
    }

    function testFakeRangeManagerCannotBindFromNonInitializer() public {
        FakeRangeManager fake = new FakeRangeManager(
            address(hook), PoolId.unwrap(hook.officialPool()), address(hook.poolManager())
        );
        vm.prank(address(0xBEEF));
        vm.expectRevert(MasonryTaxHook.UnauthorizedInitializer.selector);
        hook.bindRangeManager(MasonryRangeManager(address(fake)));
        assertEq(hook.rangeManager(), address(0), "exemption slot stays empty");
    }
}
