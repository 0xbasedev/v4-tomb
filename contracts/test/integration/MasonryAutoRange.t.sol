// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Position} from "v4-core/src/libraries/Position.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {MasonryCriticalDefense, IMasonryValidatedLevelTwap} from "../../src/masonry/MasonryCriticalDefense.sol";
import {MasonryLevelOracle} from "../../src/masonry/MasonryLevelOracle.sol";
import {MasonryLevelPrice} from "../../src/masonry/MasonryLevelPrice.sol";
import {MasonryTaxHook} from "../../src/hooks/MasonryTaxHook.sol";
import {MasonrySquareHook} from "../../src/hooks/MasonrySquareHook.sol";
import {MasonryLevelHook} from "../../src/hooks/MasonryLevelHook.sol";
import {MasonryGenesisSchedule} from "../../src/masonry/MasonryGenesisSchedule.sol";
import {MockMasonryLevel, MockMasonryUSDC} from "../unit/MasonryGenesisLPBurnFee.t.sol";
import {MasonryBuybackGuard} from "../../src/masonry/MasonryBuybackGuard.sol";
import {MasonrySquareUsdcVault} from "../../src/masonry/MasonrySquareUsdcVault.sol";
import {MasonryLevelUsdcVault, MasonryUsdcVault} from "../../src/masonry/MasonryLevelUsdcVault.sol";
import {
    MasonryGenesisLPBurnFee,
    IMasonryBurnableLevel,
    IMasonryExactInputV4Router
} from "../../src/masonry/MasonryGenesisLPBurnFee.sol";
import {MiniSwapRouter} from "../../src/swap/MiniSwapRouter.sol";
import {HookMiner} from "../utils/HookMiner.sol";

interface IMockLevelTwap {
    function mockTwapSettings() external view returns (uint256 price, bool enabled);
}

/// @dev Same mock-TWAP hook pattern as MasonryLevelHook.t.sol: the hook's
/// internal tax quote reads the settable TWAP, while the oracle contract
/// (what the vault and guard read) stays fully real and hook-fed.
contract AutoRangeMockHook is MasonryLevelHook {
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

contract StubDefenseOracle is IMasonryValidatedLevelTwap {
    uint256 private _price;
    bool private _valid = true;

    function set(
        uint256 price,
        bool valid
    ) external {
        _price = price;
        _valid = valid;
    }

    function latestValidatedTwap() external view returns (uint256, uint256, bool) {
        return (_price, block.timestamp, _valid);
    }
}

/// @notice Auto-range v2 evidence suite (design 2026-11-08 section 7 +
/// specs.md section 2 quality bar). Harness mirrors MasonryLevelHook.t.sol.
contract MasonryAutoRangeTest is Test, IMockLevelTwap {
    using StateLibrary for IPoolManager;
    using PoolIdLibrary for PoolKey;

    MockMasonryLevel private level;
    MockMasonryLevel private square;
    MockMasonryUSDC private usdc;
    MasonryGenesisSchedule private schedule;
    AutoRangeMockHook private hook;
    MasonrySquareHook private squareHook;
    PoolSwapTest private swaps;
    PoolModifyLiquidityTest private liquidity;
    PoolKey private key;
    PoolKey private squareKey;
    bool private level0;
    bool private square0;
    int24 private center;
    int24 private midpoint;
    uint256 private twap = 1e18;
    bool private mockTwap = true;
    MasonryBuybackGuard private guard;
    MasonryBuybackGuard private squareGuard;
    MiniSwapRouter private router;
    MasonryCriticalDefense private defense;

    address private constant TREASURY = address(0x777);
    address private constant KEEPER = address(0xB0B1);
    address private constant STRANGER = address(0x57AA6E);

    function mockTwapSettings() external view returns (uint256, bool) {
        return (twap, mockTwap);
    }

    function setUp() public {
        level = new MockMasonryLevel();
        usdc = new MockMasonryUSDC();
        schedule = new MasonryGenesisSchedule(block.timestamp + 1 days, address(this));
        PoolManager manager = new PoolManager(address(this));
        swaps = new PoolSwapTest(manager);
        liquidity = new PoolModifyLiquidityTest(manager);
        uint160 flags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG
            | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG;
        MasonryTaxHook.OracleConfig memory oracleConfig = _nextOracle();
        bytes memory args = abi.encode(manager, schedule, oracleConfig, level, usdc, TREASURY, uint24(3000), int24(60));
        (address expected, bytes32 salt) =
            HookMiner.find(address(this), flags, bytes.concat(type(AutoRangeMockHook).creationCode, args));
        key = _deployOracle(oracleConfig, expected, address(level));
        hook = new AutoRangeMockHook{salt: salt}(
            manager, schedule, oracleConfig, address(level), address(usdc), TREASURY, 3000, 60
        );
        level0 = address(level) < address(usdc);
        uint160 peg = _pegSqrt(level0);
        manager.initialize(key, peg);
        level.mint(address(this), 10_000_000e18);
        usdc.mint(address(this), 100_000_000_000e6);
        level.approve(address(liquidity), type(uint256).max);
        usdc.approve(address(liquidity), type(uint256).max);
        level.approve(address(swaps), type(uint256).max);
        usdc.approve(address(swaps), type(uint256).max);
        center = TickMath.getTickAtSqrtPrice(peg) / 60 * 60;
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(center - 6000, center + 6000, 1e18, 0), "");
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(center - 120, center + 120, 1e18, 0), "");

        guard = new MasonryBuybackGuard(key, 150, 100, 150);
        router = new MiniSwapRouter(hook.poolManager());
        defense = new MasonryCriticalDefense(hook.oracle());

        _deploySquarePool();
    }

    function _deploySquarePool() private {
        square = new MockMasonryLevel();
        IPoolManager manager = hook.poolManager();
        MasonrySquareHook.RoutingConfig memory config =
            MasonrySquareHook.RoutingConfig(key, TREASURY, address(this), 1e18, 100e18, 300, defense);
        uint160 flags = uint160(address(hook)) & HookMiner.FLAG_MASK;
        MasonryTaxHook.OracleConfig memory oracleConfig = _nextOracle();
        bytes memory args = abi.encode(manager, oracleConfig, square, usdc, uint24(3000), int24(60), config);
        (address expected, bytes32 salt) =
            HookMiner.find(address(this), flags, bytes.concat(type(MasonrySquareHook).creationCode, args));
        squareKey = _deployOracle(oracleConfig, expected, address(square));
        squareHook =
            new MasonrySquareHook{salt: salt}(manager, oracleConfig, address(square), address(usdc), 3000, 60, config);
        square0 = squareHook.assetIsCurrency0();
        uint160 peg = _pegSqrt(square0);
        manager.initialize(squareKey, peg);
        square.mint(address(this), 10_000_000e18);
        square.approve(address(liquidity), type(uint256).max);
        square.approve(address(swaps), type(uint256).max);
        midpoint = TickMath.getTickAtSqrtPrice(peg) / 60 * 60;
        liquidity.modifyLiquidity(squareKey, ModifyLiquidityParams(midpoint - 6000, midpoint + 6000, 1e18, 0), "");
        squareGuard = new MasonryBuybackGuard(squareKey, 150, 100, 150);
    }

    function _pegSqrt(
        bool assetIsCurrency0
    ) private pure returns (uint160) {
        return uint160(assetIsCurrency0 ? (uint256(1) << 96) / 1e6 : (uint256(1) << 96) * 1e6);
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

    // ---------------- vault factories ----------------

    function _levelVault() private returns (MasonryLevelUsdcVault) {
        return _levelVaultWithDefense(defense);
    }

    function _levelVaultWithDefense(
        MasonryCriticalDefense defense_
    ) private returns (MasonryLevelUsdcVault vault) {
        // The xTOMB band is FIXED at deployment (specs section 2, Jess
        // 2026-11-08 22:05 EST): $0.82-$1.10, widths config 18% below /
        // 10% above the $1 peg, snapped to tick spacing.
        int24 t82 = MasonryLevelPrice.tickFromPrice(0.82e18, level0) / 60 * 60;
        int24 t110 = MasonryLevelPrice.tickFromPrice(1.10e18, level0) / 60 * 60;
        int24 bandLower = t82 < t110 ? t82 : t110;
        int24 bandUpper = t82 < t110 ? t110 : t82;
        vault = new MasonryLevelUsdcVault(key, bandLower, bandUpper, guard, router, defense_, address(this));
        level.approve(address(vault), type(uint256).max);
        usdc.approve(address(vault), type(uint256).max);
        vault.setKeeper(KEEPER, true);
    }

    function _squareVault(
        int24 halfRange
    ) private returns (MasonrySquareUsdcVault vault) {
        return _squareVaultWithGuard(halfRange, squareGuard);
    }

    function _squareVaultWithGuard(
        int24 halfRange,
        MasonryBuybackGuard guard_
    ) private returns (MasonrySquareUsdcVault vault) {
        vault = new MasonrySquareUsdcVault(
            squareKey, midpoint - halfRange, midpoint + halfRange, guard_, router, defense, address(this)
        );
        square.approve(address(vault), type(uint256).max);
        usdc.approve(address(vault), type(uint256).max);
        vault.setKeeper(KEEPER, true);
        _testTimelineFeeGate(vault);
    }

    /// @dev Fee-gate config for tests that assert recenter MECHANICS on
    /// warped test timelines: the observation window is compressed to a
    /// minute and the horizon set to a week so the estimator can read
    /// the real fee growth the price drives generate. The gate's
    /// refusal behavior at production-shaped parameters (24h window /
    /// 24h horizon / 100% margin) is asserted in the dedicated fee-gate
    /// tests below, which re-set these values explicitly.
    function _testTimelineFeeGate(
        MasonrySquareUsdcVault vault
    ) private {
        vault.setFeeGateParams(7 days, 1 minutes, 10_000);
    }

    // ---------------- market helpers ----------------

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

    function _warmOracle() private {
        uint256 start = block.timestamp;
        hook.checkpoint();
        vm.warp(start + 30 minutes);
        _swapOn(key, !level0, -1e6);
    }

    function _warmSquareOracle() private {
        uint256 start = block.timestamp;
        squareHook.checkpoint();
        vm.warp(start + 30 minutes);
        _swapOn(squareKey, !square0, -1e6);
    }

    /// @dev Move a pool's spot with one swap, then let the 30-minute TWAP
    /// settle at the new price (checkpoint, warp, one small price-changing
    /// swap to refresh freshness).
    function _moveLevelTwap(
        bool zeroForOne,
        int256 amount
    ) private {
        _swapOn(key, zeroForOne, amount);
        uint256 start = block.timestamp;
        hook.checkpoint();
        vm.warp(start + 31 minutes);
        _swapOn(key, !level0, -1e6);
    }

    function _moveSquareTwap(
        bool zeroForOne,
        int256 amount
    ) private {
        _swapOn(squareKey, zeroForOne, amount);
        uint256 start = block.timestamp;
        squareHook.checkpoint();
        vm.warp(start + 31 minutes);
        _swapOn(squareKey, !square0, -1e6);
    }

    function _afterGenesis() private {
        vm.warp(schedule.end() + 1);
    }

    function _levelTwap() private view returns (uint256 price, bool valid) {
        (price,, valid) = hook.oracle().latestValidatedTwap();
    }

    /// @dev Drive the LEVEL TWAP down to <= stopPrice in absorbable
    /// chunks (the hook rejects swaps the pool cannot fully fill).
    function _driveLevelDown(uint256 stopPrice, int256 sellChunk) private {
        for (uint256 i = 0; i < 40; i++) {
            (uint256 price, bool valid) = _levelTwap();
            if (valid && price <= stopPrice) return;
            _moveLevelTwap(level0, sellChunk);
        }
        fail();
    }

    function _driveSquareDown(uint256 stopPrice, int256 sellChunk) private {
        for (uint256 i = 0; i < 40; i++) {
            (uint256 price, bool valid) = _squareTwap();
            if (valid && price <= stopPrice) return;
            _moveSquareTwap(square0, sellChunk);
        }
        fail();
    }

    function _driveLevelUp(uint256 stopPrice, int256 buyChunk) private {
        for (uint256 i = 0; i < 40; i++) {
            (uint256 price, bool valid) = _levelTwap();
            if (valid && price >= stopPrice) return;
            _moveLevelTwap(!level0, buyChunk);
        }
        fail();
    }

    function _spotTick(
        PoolKey memory pool
    ) private view returns (int24) {
        (uint160 sqrt,,,) = hook.poolManager().getSlot0(pool.toId());
        return TickMath.getTickAtSqrtPrice(sqrt);
    }

    function _driveSquareUpTo(uint256 stopPrice, int256 buyChunk) private {
        for (uint256 i = 0; i < 40; i++) {
            (uint256 price, bool valid) = _squareTwap();
            if (valid && price >= stopPrice) return;
            _moveSquareTwap(!square0, buyChunk);
        }
        fail();
    }

    /// @dev Buy the SQUARE TWAP up in chunks until the vault reports
    /// itself eligible to rebalance.
    function _driveSquareUp(MasonrySquareUsdcVault vault) private {
        for (uint256 i = 0; i < 30; i++) {
            (bool eligible,) = vault.rebalanceNeeded();
            if (eligible) return;
            _moveSquareTwap(!square0, -5_000e6);
        }
        fail();
    }

    function _squareTwap() private view returns (uint256 price, bool valid) {
        (price,, valid) = squareHook.oracle().latestValidatedTwap();
    }

    function _positionLiquidity(
        address vault,
        PoolKey memory pool,
        int24 lower,
        int24 upper
    ) private view returns (uint256) {
        bytes32 positionId = Position.calculatePositionKey(vault, lower, upper, bytes32(0));
        return hook.poolManager().getPositionLiquidity(pool.toId(), positionId);
    }

    function _depositLevel(
        MasonryLevelUsdcVault vault,
        uint256 shares
    ) private {
        vault.deposit(shares, type(uint256).max, type(uint256).max, address(this));
    }

    function _depositSquare(
        MasonrySquareUsdcVault vault,
        uint256 shares
    ) private {
        vault.deposit(shares, type(uint256).max, type(uint256).max, address(this));
    }

    // ================= LEVEL (peg-centered) =================

    function testLevelRebalanceRevertsDuringGenesis() public {
        MasonryLevelUsdcVault vault = _levelVault();
        _depositLevel(vault, 4e16);
        _warmOracle();
        uint256 genesisEnd = schedule.end();
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(MasonryUsdcVault.GenesisLocked.selector, genesisEnd));
        vault.rebalance();
        (bool eligible, uint8 reason) = vault.rebalanceNeeded();
        assertFalse(eligible);
        assertEq(reason, 6);
    }

    function testLevelNeverRecentersAtPeg() public {
        // Policy (Jess 2026-11-08 22:05 EST): the xTOMB vault's band is
        // FIXED ($0.82-$1.10) and it has NO recenter path. At the peg,
        // with every gate open, a rebalance is not eligible and the
        // position never moves. This is also the forwarded
        // recenter-trigger bug lesson in its strongest form: the target
        // ticks equal the live ticks at every spot, forever — no churn.
        MasonryLevelUsdcVault vault = _levelVault();
        _depositLevel(vault, 4e16);
        _warmOracle();
        _afterGenesis();
        _warmOracle();
        (uint256 price, bool valid) = _levelTwap();
        assertTrue(valid);
        assertApproxEqRel(price, 1e18, 0.01e18);
        int24 lowerBefore = vault.tickLower();
        int24 upperBefore = vault.tickUpper();
        uint256 liquidityBefore = vault.totalPositionLiquidity();
        (bool eligible, uint8 reason) = vault.rebalanceNeeded();
        assertFalse(eligible);
        assertEq(reason, 0);
        vm.prank(KEEPER);
        vm.expectRevert(MasonryUsdcVault.NotEligible.selector);
        vault.rebalance();
        assertEq(vault.tickLower(), lowerBefore);
        assertEq(vault.tickUpper(), upperBefore);
        assertEq(vault.totalPositionLiquidity(), liquidityBefore);
    }

    function testLevelNeverRecentersAbovePeg() public {
        // Same negative proof with the TWAP driven above the peg, inside
        // and through the band: the vault still does not chase price.
        MasonryLevelUsdcVault vault = _levelVault();
        _depositLevel(vault, 4e16);
        _warmOracle();
        _afterGenesis();
        _warmOracle();
        _driveLevelUp(1.05e18, -20_000e6);
        (uint256 price, bool valid) = _levelTwap();
        assertTrue(valid);
        assertGt(price, 1.04e18);
        int24 lowerBefore = vault.tickLower();
        int24 upperBefore = vault.tickUpper();
        uint256 liquidityBefore = vault.totalPositionLiquidity();
        (bool eligible, uint8 reason) = vault.rebalanceNeeded();
        assertFalse(eligible);
        assertEq(reason, 0);
        vm.prank(KEEPER);
        vm.expectRevert(MasonryUsdcVault.NotEligible.selector);
        vault.rebalance();
        assertEq(vault.tickLower(), lowerBefore);
        assertEq(vault.tickUpper(), upperBefore);
        assertEq(vault.totalPositionLiquidity(), liquidityBefore);
    }

    function testLevelDepegHold() public {
        // No Critical Defense wired here: at a $0.60 TWAP the real defense
        // would (correctly) trip first and mask the DepegHold path.
        MasonryLevelUsdcVault vault = _levelVaultWithDefense(MasonryCriticalDefense(address(0)));
        _depositLevel(vault, 4e16);
        _warmOracle();
        _afterGenesis();
        _warmOracle();
        // Drive the TWAP to ~$0.60 with a large sell and let it settle.
        _driveLevelDown(0.88e18, -1e22);
        (uint256 price, bool valid) = _levelTwap();
        assertTrue(valid);
        assertLt(price, 0.90e18);
        console2.log("depeg TWAP:", price);

        int24 lowerBefore = vault.tickLower();
        int24 upperBefore = vault.tickUpper();
        uint256 liquidityBefore = vault.totalPositionLiquidity();

        (bool eligible, uint8 reason) = vault.rebalanceNeeded();
        assertFalse(eligible);
        assertEq(reason, 8);
        vm.prank(KEEPER);
        vm.expectRevert(MasonryUsdcVault.DepegHold.selector);
        vault.rebalance();

        // The vault did NOT chase price down: range and position untouched,
        // still holding its LEVEL as deployed defense capital.
        assertEq(vault.tickLower(), lowerBefore);
        assertEq(vault.tickUpper(), upperBefore);
        assertEq(vault.totalPositionLiquidity(), liquidityBefore);
        assertEq(
            _positionLiquidity(address(vault), key, lowerBefore, upperBefore), liquidityBefore
        );
    }

    function testLevelSuggestedRangeIgnoresTwapDrift() public {
        MasonryLevelUsdcVault vault = _levelVault();
        _depositLevel(vault, 4e16);
        _warmOracle();
        _afterGenesis();
        _warmOracle();
        (, int24 centerAtPeg,) = _suggested(vault);
        // Drift the TWAP to ~$0.95 (in band, above the depeg threshold).
        _driveLevelDown(0.965e18, -5e21);
        (uint256 price, bool valid) = _levelTwap();
        assertTrue(valid);
        assertGt(price, 0.90e18);
        assertLt(price, 0.99e18);
        console2.log("drift TWAP:", price);
        (int24 sugLower, int24 centerDrifted, int24 twapTick) = _suggested(vault);
        // Center is still the peg tick, not the drifted TWAP tick, and
        // the suggested range is the live fixed band itself.
        assertEq(centerDrifted, centerAtPeg);
        assertTrue(centerDrifted != twapTick);
        assertEq(sugLower, vault.tickLower());
    }

    function _suggested(
        MasonryLevelUsdcVault vault
    ) private view returns (int24 lower, int24 center, int24 twapTick) {
        (lower,, center) = vault.suggestedRange();
        (twapTick,,) = vault.currentTwapTick();
    }

    function _squareVaultAtTarget() private returns (MasonrySquareUsdcVault) {
        return _squareVaultAtTargetWithGuard(squareGuard);
    }

    function _squareVaultAtTargetWithGuard(
        MasonryBuybackGuard guard_
    ) private returns (MasonrySquareUsdcVault vault) {
        // Deployed AT the exact trigger's target band for the peg
        // center: 1800 ticks down / 1000 up, the upper edge snapped to
        // tick spacing (1020), exactly as the vault constructs it.
        vault = new MasonrySquareUsdcVault(
            squareKey, midpoint - 1800, midpoint + 1020, guard_, router, defense, address(this)
        );
        square.approve(address(vault), type(uint256).max);
        usdc.approve(address(vault), type(uint256).max);
        vault.setKeeper(KEEPER, true);
        _testTimelineFeeGate(vault);
    }

    /// @dev Replica of the OLD buggy trigger from the findings doc: it
    /// derived an expected band from the live band's tick MIDPOINT
    /// using one symmetric stored half-width, instead of comparing the
    /// live ticks against the target ticks. On an asymmetric band the
    /// midpoint is offset from the true center, so this returns true
    /// even when the band is exactly where it should be — the spurious
    /// every-cooldown fire (and the endless retry at a static price).
    function _oldBuggyTrigger(
        int24 liveLower,
        int24 liveUpper
    ) private pure returns (bool) {
        int24 midpoint = (liveLower + liveUpper) / 2;
        return midpoint - 1800 != liveLower || midpoint + 1800 != liveUpper;
    }

    // ================= SQUARE (TWAP-centered) =================

    /// @dev Eligible drift state under the exact trigger: the TWAP is
    /// driven up until an edge has drifted at/past its per-side
    /// threshold, with the spot tick still INSIDE the live band.
    function _squareDriftedUp() private returns (MasonrySquareUsdcVault vault) {
        return _squareDriftedUpWithGuard(squareGuard);
    }

    function _squareDriftedUpWithGuard(
        MasonryBuybackGuard guard_
    ) private returns (MasonrySquareUsdcVault vault) {
        vault = _squareVaultAtTargetWithGuard(guard_);
        // 4e16, not the 4e17 used elsewhere: at 4e17 the drift
        // recenter's swap leg is ~$20k into this pool's depth and its
        // price impact alone exceeds the guard's caps, so the leg can
        // never execute; at 4e16 the leg is ~$2k and clears them.
        _depositSquare(vault, 4e16);
        _warmSquareOracle();
        _driveSquareUp(vault);
        (bool eligible, uint8 reason) = vault.rebalanceNeeded();
        assertTrue(eligible);
        assertEq(reason, 2);
        int24 spot = _spotTick(squareKey);
        assertLt(spot, vault.tickUpper());
        assertGt(spot, vault.tickLower());
    }

    function testSquareRecenterBeforeFullExit() public {
        MasonrySquareUsdcVault vault = _squareDriftedUp();
        (int24 twapTick,, bool twapValid) = vault.currentTwapTick();
        assertTrue(twapValid);
        // Bar point 1: the TWAP is still INSIDE the range (the position
        // has not fully exited) and the rebalance already fires.
        assertLt(twapTick, vault.tickUpper());
        assertGt(twapTick, vault.tickLower());
        (bool eligible, uint8 reason) = vault.rebalanceNeeded();
        assertTrue(eligible);
        assertEq(reason, 2);

        uint256 g0 = gasleft();
        vm.prank(KEEPER);
        vault.rebalance();
        console2.log("square rebalance gas:", g0 - gasleft());

        // Bar point 2 (xSHARE leg): the new band is the target band —
        // the TWAP tick as center, SEPARATE asymmetric widths
        // (1800 down / 1000 up, snapped to tick spacing).
        assertApproxEqAbs(vault.tickLower(), twapTick - 1800, 60);
        assertApproxEqAbs(vault.tickUpper(), twapTick + 1000, 60);
        assertGt(twapTick, vault.tickLower());
        assertLt(twapTick, vault.tickUpper());
        // Design 7.5: ratio invariant against the real position.
        assertEq(
            vault.totalPositionLiquidity(),
            _positionLiquidity(address(vault), squareKey, vault.tickLower(), vault.tickUpper())
        );
    }

    function testSquareRecenterAfterFullExit() public {
        // Full exit on the UP side: the spot tick leaves the live band
        // entirely (reason 1 in the exact trigger). The position is then
        // holding mostly USDC, so the recovery leg BUYS the asset
        // (untaxed) — the down-side full exit is covered by the drift
        // test below because its taxed leg is a separate concern.
        // Wide-tolerance guard fixture: the leg is most of the position
        // and the tight production guard's impact cap would (correctly)
        // refuse it against this test pool's depth.
        MasonrySquareUsdcVault vault =
            _squareVaultAtTargetWithGuard(new MasonryBuybackGuard(squareKey, 500, 500, 500));
        _depositSquare(vault, 4e17);
        _warmSquareOracle();
        _driveSquareUpTo(1.13e18, -20_000e6);
        (uint256 price, bool valid) = _squareTwap();
        assertTrue(valid);
        assertGt(price, 1.11e18);
        int24 spot = _spotTick(squareKey);
        assertTrue(spot >= vault.tickUpper());
        (bool eligible, uint8 reason) = vault.rebalanceNeeded();
        assertTrue(eligible);
        assertEq(reason, 1);
        vm.prank(KEEPER);
        vault.rebalance();
        (int24 twapTick,,) = vault.currentTwapTick();
        assertApproxEqAbs(vault.tickLower(), twapTick - 1800, 60);
        assertApproxEqAbs(vault.tickUpper(), twapTick + 1000, 60);
        assertGt(twapTick, vault.tickLower());
        assertLt(twapTick, vault.tickUpper());
    }

    function testSquareRecenterAfterDownDrift() public {
        // Down wing: TWAP ~-10% — still inside the live band (lower
        // width 1800) but the lower edge has drifted well past its
        // threshold (span 1800 x 666/1800 = 666), so the exact trigger
        // fires with reason 2 and the vault recenters on the TWAP.
        MasonrySquareUsdcVault vault =
            _squareVaultAtTargetWithGuard(new MasonryBuybackGuard(squareKey, 500, 500, 500));
        _depositSquare(vault, 4e16);
        _warmSquareOracle();
        _driveSquareDown(0.905e18, -4e21);
        (uint256 price, bool valid) = _squareTwap();
        assertTrue(valid);
        assertGt(price, 0.88e18);
        assertLt(price, 0.92e18);
        (int24 twapTick,,) = vault.currentTwapTick();
        assertGt(twapTick, vault.tickLower());
        (bool eligible, uint8 reason) = vault.rebalanceNeeded();
        assertTrue(eligible);
        assertEq(reason, 2);
        // The Fire Tax is elevated at a ~0.90 TWAP by design, so this
        // recovery costs more than the default 1% loss cap allows; the
        // cap is an admin parameter and is set for that reality here.
        vault.setRebalanceParams(6 hours, 24 hours, 500, 1_000e18, 1e18);
        // The fee gate is likewise an admin parameter: a taxed depeg
        // recovery on a small position is exactly the recenter whose
        // trailing fee outlook cannot cover its cost at a 100% margin,
        // so the admin waves it through at 1% for this scenario. The
        // gate's refusal behavior has its own dedicated tests below.
        vault.setFeeGateParams(7 days, 1 minutes, 100);
        vm.prank(KEEPER);
        vault.rebalance();
        assertApproxEqAbs(vault.tickLower(), twapTick - 1800, 60);
        assertApproxEqAbs(vault.tickUpper(), twapTick + 1000, 60);
        assertGt(twapTick, vault.tickLower());
        assertLt(twapTick, vault.tickUpper());
    }

    function testSquareDriftBelowThresholdBothWings() public {
        // The drift threshold is BOUNDED on both wings: a ~3% move
        // shifts the target band ~300 ticks, below the 666-tick
        // threshold the exact trigger derives mid-band, so nothing
        // fires even though target ticks != live ticks.
        MasonrySquareUsdcVault vault = _squareVaultAtTarget();
        _depositSquare(vault, 4e17);
        _warmSquareOracle();
        _driveSquareUpTo(1.025e18, -5_000e6);
        (uint256 priceUp, bool validUp) = _squareTwap();
        assertTrue(validUp);
        assertGt(priceUp, 1.02e18);
        assertLt(priceUp, 1.045e18);
        (int24 sugLower, int24 sugUpper,) = vault.suggestedRange();
        assertTrue(sugLower != vault.tickLower() || sugUpper != vault.tickUpper());
        (bool eligible, uint8 reason) = vault.rebalanceNeeded();
        assertFalse(eligible);
        assertEq(reason, 0);
        vm.prank(KEEPER);
        vm.expectRevert(MasonryUsdcVault.NotEligible.selector);
        vault.rebalance();
        // Same on the down wing: back through the peg to ~-3%.
        _driveSquareDown(0.972e18, -4e21);
        (uint256 priceDown, bool validDown) = _squareTwap();
        assertTrue(validDown);
        assertGt(priceDown, 0.955e18);
        assertLt(priceDown, 0.98e18);
        (eligible, reason) = vault.rebalanceNeeded();
        assertFalse(eligible);
        assertEq(reason, 0);
        vm.prank(KEEPER);
        vm.expectRevert(MasonryUsdcVault.NotEligible.selector);
        vault.rebalance();
    }

    function testSquareQuietMarketZeroRecenters() public {
        // Corrected-rerun evidence, on-chain: in a quiet market the
        // exact trigger makes ZERO recenters. The band sits exactly at
        // its target; across three cooldown windows, with the TWAP
        // kept fresh by dust trades, neither the keeper path nor the
        // permissionless poke ever fires.
        MasonrySquareUsdcVault vault = _squareVaultAtTarget();
        _depositSquare(vault, 4e17);
        _warmSquareOracle();
        // Regression: the OLD buggy midpoint trigger fires on this
        // exact state (its midpoint-derived expected band never equals
        // the asymmetric live band). The exact trigger's equality skip
        // is what the rest of this test proves.
        assertTrue(_oldBuggyTrigger(vault.tickLower(), vault.tickUpper()));
        int24 lowerBefore = vault.tickLower();
        int24 upperBefore = vault.tickUpper();
        for (uint256 i = 0; i < 3; i++) {
            (bool eligible, uint8 reason) = vault.rebalanceNeeded();
            assertFalse(eligible);
            assertEq(reason, 0);
            vm.prank(KEEPER);
            vm.expectRevert(MasonryUsdcVault.NotEligible.selector);
            vault.rebalance();
            vm.prank(STRANGER);
            vm.expectRevert(MasonryUsdcVault.NotEligible.selector);
            vault.pokeRebalance();
            vm.warp(block.timestamp + 6 hours + 1);
            _moveSquareTwap(!square0, -1e6); // dust trade keeps the TWAP fresh
        }
        assertEq(vault.tickLower(), lowerBefore);
        assertEq(vault.tickUpper(), upperBefore);
        assertEq(vault.lastRebalanceAt(), 0);
    }

    function testSquareNoRefireAcrossCooldownWindows() public {
        // Requirement: no repeated firing at a static price. After a
        // real recenter, the target ticks equal the live ticks, so
        // across multiple cooldown windows at an unmoved price the
        // vault stays silent — the old trigger retried forever here.
        MasonrySquareUsdcVault vault = _squareDriftedUp();
        vm.prank(KEEPER);
        vault.rebalance();
        assertTrue(vault.lastRebalanceAt() != 0);
        int24 lowerBefore = vault.tickLower();
        int24 upperBefore = vault.tickUpper();
        for (uint256 i = 0; i < 3; i++) {
            vm.warp(block.timestamp + 6 hours + 1);
            _moveSquareTwap(!square0, -1e6); // refresh TWAP at the same price
            (bool eligible, uint8 reason) = vault.rebalanceNeeded();
            assertFalse(eligible);
            assertEq(reason, 0);
            vm.prank(KEEPER);
            vm.expectRevert(MasonryUsdcVault.NotEligible.selector);
            vault.rebalance();
        }
        assertEq(vault.tickLower(), lowerBefore);
        assertEq(vault.tickUpper(), upperBefore);
    }

    function testSquareCooldownBlocksChurn() public {
        MasonrySquareUsdcVault vault = _squareDriftedUp();
        vm.prank(KEEPER);
        vault.rebalance();
        (bool eligible, uint8 reason) = vault.rebalanceNeeded();
        assertFalse(eligible);
        assertEq(reason, 3);
        uint256 earliest = vault.lastRebalanceAt() + vault.rebalanceCooldown();
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(MasonryUsdcVault.CooldownActive.selector, earliest));
        vault.rebalance();
    }

    function testSquareVolatilityWidensRange() public {
        MasonrySquareUsdcVault vault = _squareDriftedUp();
        (int24 lo0, int24 hi0,) = vault.suggestedRange();
        uint256 width0 = uint256(int256(hi0) - int256(lo0));
        vault.setRangeBounds(1800, 1000, 4000, 900, 666);
        (int24 lo1, int24 hi1,) = vault.suggestedRange();
        uint256 width1 = uint256(int256(hi1) - int256(lo1));
        assertGt(width1, width0 + 1000);
        vault.setRangeBounds(1800, 1000, 4000, -900, 666);
        (int24 lo2, int24 hi2,) = vault.suggestedRange();
        uint256 width2 = uint256(int256(hi2) - int256(lo2));
        assertLt(width2, width0 - 1000);
    }

    function testTwapStaysValidAcrossRebalance() public {
        MasonrySquareUsdcVault vault = _squareDriftedUp();
        (uint256 before,, bool validBefore) = squareHook.oracle().latestValidatedTwap();
        assertTrue(validBefore);
        vm.prank(KEEPER);
        vault.rebalance();
        // Design 7.17 / 1.6: same-bucket property — the TWAP must still be
        // valid immediately after the rebalance, in the same transaction
        // sequence, with no thin interval recorded.
        uint256 after_ = squareHook.oracle().validatedPrice(squareKey.toId());
        assertApproxEqRel(after_, before, 0.02e18);
    }

    function testRatioAccountingAfterRebalance() public {
        MasonrySquareUsdcVault vault = _squareDriftedUp();
        uint256 supplyBefore = vault.totalSupply();
        vm.prank(KEEPER);
        vault.rebalance();
        assertEq(vault.totalSupply(), supplyBefore);
        assertEq(
            vault.totalPositionLiquidity(),
            _positionLiquidity(address(vault), squareKey, vault.tickLower(), vault.tickUpper())
        );
        // Deposit after the rebalance prices through the new ratio.
        _depositSquare(vault, 1e17);
        assertEq(vault.totalSupply(), supplyBefore + 1e17);
        assertEq(
            vault.totalPositionLiquidity(),
            _positionLiquidity(address(vault), squareKey, vault.tickLower(), vault.tickUpper())
        );
        // Full redemption after the rebalance unwinds exactly.
        uint256 squareBefore = square.balanceOf(address(this));
        uint256 usdcBefore = usdc.balanceOf(address(this));
        vault.redeem(vault.balanceOf(address(this)), address(this));
        assertEq(vault.totalSupply(), 0);
        assertEq(vault.totalPositionLiquidity(), 0);
        assertGt(square.balanceOf(address(this)), squareBefore);
        assertGt(usdc.balanceOf(address(this)), usdcBefore);
    }

    // ================= fail-closed guards =================

    function testRebalanceRevertsOnStaleOracle() public {
        MasonrySquareUsdcVault vault = _squareVault(600);
        _depositSquare(vault, 4e17);
        _warmSquareOracle();
        vm.warp(block.timestamp + 31 minutes);
        squareHook.checkpoint();
        (bool eligible, uint8 reason) = vault.rebalanceNeeded();
        assertFalse(eligible);
        assertEq(reason, 4);
        vm.prank(KEEPER);
        vm.expectRevert(MasonryUsdcVault.OracleInvalid.selector);
        vault.rebalance();
    }

    function testRebalanceRevertsOnSpotTwapConflict() public {
        MasonryBuybackGuard tightGuard = new MasonryBuybackGuard(squareKey, 150, 100, 150);
        MasonrySquareUsdcVault vault = new MasonrySquareUsdcVault(
            squareKey, midpoint - 600, midpoint + 600, tightGuard, router, defense, address(this)
        );
        square.approve(address(vault), type(uint256).max);
        usdc.approve(address(vault), type(uint256).max);
        vault.setKeeper(KEEPER, true);
        _depositSquare(vault, 4e17);
        _warmSquareOracle();
        // One large buy: spot jumps far away from the (unchanged) TWAP.
        _swapOn(squareKey, !square0, -300_000e6);
        vm.prank(KEEPER);
        vm.expectRevert(MasonryBuybackGuard.UnsafePrice.selector);
        vault.rebalance();
    }

    function testRebalanceRevertsWhenDefenseActive() public {
        StubDefenseOracle stub = new StubDefenseOracle();
        stub.set(1e18, true);
        MasonryCriticalDefense stubDefense = new MasonryCriticalDefense(stub);
        MasonryLevelUsdcVault vault = _levelVaultWithDefense(stubDefense);
        _depositLevel(vault, 4e16);
        _warmOracle();
        _afterGenesis();
        _warmOracle();
        stub.set(0.89e18, true);
        assertTrue(stubDefense.sync());
        (bool eligible, uint8 reason) = vault.rebalanceNeeded();
        assertFalse(eligible);
        assertEq(reason, 5);
        vm.prank(KEEPER);
        vm.expectRevert(MasonryUsdcVault.DefenseActive.selector);
        vault.rebalance();
    }

    function testLossCapRevertsAndRestoresPosition() public {
        MasonrySquareUsdcVault vault =
            _squareVaultAtTargetWithGuard(new MasonryBuybackGuard(squareKey, 500, 500, 500));
        _depositSquare(vault, 4e16);
        _warmSquareOracle();
        // ~-10%: drift-eligible on the lower wing, position is
        // asset-heavy, so the rebalance's swap leg must SELL the asset
        // and pay the Fire Tax.
        _driveSquareDown(0.905e18, -4e21);
        (uint256 price, bool valid) = _squareTwap();
        assertTrue(valid);
        assertGt(price, 0.88e18);
        assertLt(price, 0.92e18);
        (bool eligible, uint8 reason) = vault.rebalanceNeeded();
        assertTrue(eligible);
        assertEq(reason, 2);
        // A 1bp loss cap is below any taxed swap leg: the rebalance must
        // revert and restore the position exactly (atomicity).
        vault.setRebalanceParams(6 hours, 24 hours, 1, 1_000e18, 0);
        // The fee gate is waived through at a 1% margin so the loss cap
        // is the binding constraint under test (the gate's own refusal
        // behavior has dedicated tests below).
        vault.setFeeGateParams(7 days, 1 minutes, 100);
        int24 lowerBefore = vault.tickLower();
        int24 upperBefore = vault.tickUpper();
        uint256 liquidityBefore = vault.totalPositionLiquidity();
        vm.prank(KEEPER);
        vm.expectRevert(MasonryUsdcVault.LossCapExceeded.selector);
        vault.rebalance();
        assertEq(vault.tickLower(), lowerBefore);
        assertEq(vault.tickUpper(), upperBefore);
        assertEq(vault.totalPositionLiquidity(), liquidityBefore);
        assertEq(_positionLiquidity(address(vault), squareKey, lowerBefore, upperBefore), liquidityBefore);
    }

    function testPositionTooSmallReverts() public {
        MasonrySquareUsdcVault vault = _squareVaultAtTarget();
        _depositSquare(vault, 1e9);
        _warmSquareOracle();
        (bool eligible, uint8 reason) = vault.rebalanceNeeded();
        assertFalse(eligible);
        assertEq(reason, 7);
        vm.prank(KEEPER);
        vm.expectRevert(MasonryUsdcVault.PositionTooSmall.selector);
        vault.rebalance();
    }

    // ================= keeper redundancy =================

    function testKeeperAuthorizationLifecycle() public {
        MasonrySquareUsdcVault vault = _squareDriftedUp();
        vm.prank(STRANGER);
        vm.expectRevert(MasonryUsdcVault.NotKeeper.selector);
        vault.rebalance();
        vm.prank(KEEPER);
        vault.rebalance();
        // Revoke, re-establish eligibility, and the ex-keeper is powerless.
        vault.setKeeper(KEEPER, false);
        vm.warp(block.timestamp + 6 hours + 1);
        _driveSquareUp(vault);
        (bool eligible,) = vault.rebalanceNeeded();
        assertTrue(eligible);
        vm.prank(KEEPER);
        vm.expectRevert(MasonryUsdcVault.NotKeeper.selector);
        vault.rebalance();
    }

    function testPokeRebalanceWhenKeepersAbsent() public {
        MasonrySquareUsdcVault vault = _squareDriftedUp();
        vault.setKeeper(KEEPER, false);
        (int24 lo, int24 hi,) = vault.suggestedRange();
        vm.prank(STRANGER);
        vault.pokeRebalance();
        assertEq(vault.tickLower(), lo);
        assertEq(vault.tickUpper(), hi);
    }

    function testPokeRespectsDelayAfterKeeperRebalance() public {
        MasonrySquareUsdcVault vault =
            _squareDriftedUpWithGuard(new MasonryBuybackGuard(squareKey, 500, 500, 500));
        vm.prank(KEEPER);
        vault.rebalance();
        uint256 rebalancedAt = vault.lastRebalanceAt();
        uint256 pokeEarliest = rebalancedAt + vault.pokeDelay();
        _driveSquareUp(vault);
        vm.prank(STRANGER);
        vm.expectRevert(abi.encodeWithSelector(MasonryUsdcVault.CooldownActive.selector, pokeEarliest));
        vault.pokeRebalance();
        vm.warp(pokeEarliest + 1);
        _moveSquareTwap(!square0, -1e6); // refresh the TWAP at the moved price
        (bool eligible,) = vault.rebalanceNeeded();
        assertTrue(eligible);
        vm.prank(STRANGER);
        vault.pokeRebalance();
    }

    // ================= downstream wiring after a rebalance =================

    function testFeeModuleRedeemsAcrossTwapMove() public {
        MasonryLevelUsdcVault vault = _levelVault();
        _depositLevel(vault, 4e16);
        MasonryGenesisLPBurnFee collector = new MasonryGenesisLPBurnFee(
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
        vault.approve(address(collector), type(uint256).max);
        _warmOracle();
        _afterGenesis();
        _warmOracle();
        collector.collectAndProcess(1e16);
        uint256 burnedBefore = level.totalBurned();
        assertGt(burnedBefore, 0);
        // The peg vault never recenters (fixed band), so what the fee
        // module depends on is redemption through the v2 ratio
        // accounting — exercised again here after a TWAP move.
        _driveLevelDown(0.965e18, -5e21);
        collector.collectAndProcess(1e16);
        assertGt(level.totalBurned(), burnedBefore);
    }

    function testSquarePolDepositAfterRebalance() public {
        MasonrySquareUsdcVault pol = _squareVaultWithGuard(600, new MasonryBuybackGuard(squareKey, 500, 500, 500));
        _depositSquare(pol, 4e17);
        squareHook.bindPolVault(pol);
        _warmSquareOracle();
        // Real fee history for the vault's fee gate: this rebalance is
        // a range-width change that no price drive precedes, so without
        // traded volume the gate would (correctly) refuse it for lack
        // of any fee outlook.
        _generateSquareVolume(6, 20_000e6);
        _driveSquareUp(pol);
        vm.prank(KEEPER);
        pol.rebalance();
        assertTrue(pol.tickLower() != midpoint - 600);
        // Mirror the existing POL flow: at Genesis start, warm the square
        // oracle, then a taxed sell routes POL into the (rebalanced) vault.
        vm.warp(schedule.start());
        squareHook.checkpoint();
        vm.warp(schedule.start() + 30 minutes);
        _swapOn(squareKey, !square0, -1e6);
        _swapOn(squareKey, square0, -100e18);
        assertGt(pol.balanceOf(TREASURY), 0);
    }

    // ================= admin surface =================

    function testAdminSettersValidate() public {
        MasonryLevelUsdcVault vault = _levelVault();
        vm.prank(STRANGER);
        vm.expectRevert();
        vault.setKeeper(STRANGER, true);
        vm.expectRevert(MasonryUsdcVault.InvalidParameters.selector);
        vault.setRebalanceParams(0, 24 hours, 100, 1_000e18, 1e18);
        vm.expectRevert(MasonryUsdcVault.InvalidParameters.selector);
        vault.setRangeBounds(5000, 1000, 4000, 0, 666);
        vm.expectRevert(MasonryUsdcVault.InvalidParameters.selector);
        vault.setRangeBounds(1800, 1000, 4000, 0, 0);
        vm.expectRevert(MasonryUsdcVault.InvalidParameters.selector);
        vault.setPegParams(1e18, 1e18);
        // Valid changes apply and emit through the getters.
        vault.setRangeBounds(1200, 800, 4000, 100, 666);
        assertEq(vault.lowerWidthTicks(), 1200);
        assertEq(vault.upperWidthTicks(), 800);
        assertEq(vault.volatilityTicks(), 100);
        assertEq(vault.driftNumerator(), 666);
    }

    // ================= expected-fees gate (bar point 3) =================
    // These tests run the gate at production-shaped parameters
    // (24h trailing window / 24h horizon / 100% margin), NOT the
    // compressed test-timeline config the vault factories install.

    /// @dev Strip the 4-byte selector from revert data for decoding.
    function _afterSelector(
        bytes memory data
    ) private pure returns (bytes memory args) {
        args = new bytes(data.length - 4);
        for (uint256 i = 0; i < args.length; i++) {
            args[i] = data[i + 4];
        }
    }

    /// @dev Trade back and forth on the SQUARE pool to generate real
    /// fee growth, ending near the peg. Sells pay the hook's Fire Tax
    /// out of this contract's mock balances. The caller must have
    /// warmed the square oracle first: the hook refuses sells while
    /// its TWAP is invalid. Each round trip checkpoints and warps a
    /// few minutes so the TWAP tracks the oscillating spot.
    function _generateSquareVolume(
        uint256 roundTrips,
        uint256 chunkUsdc
    ) private {
        for (uint256 i = 0; i < roundTrips; i++) {
            uint256 before = square.balanceOf(address(this));
            _swapOn(squareKey, !square0, -int256(chunkUsdc));
            uint256 bought = square.balanceOf(address(this)) - before;
            // Sell back 95%: the residual covers the hook's sell-side
            // tax mechanics, which can draw more than the swap input.
            _swapOn(squareKey, square0, -int256(bought * 95 / 100));
            squareHook.checkpoint();
            vm.warp(block.timestamp + 5 minutes);
        }
    }

    /// @dev Vault with a completed 24h observation pair: deposit at t0
    /// (first snapshot), warm the oracle, generate `roundTrips` of
    /// volume, warp 24h, deposit again (the pair rolls), re-warm the
    /// oracle and drive the TWAP up into a drift-eligible state
    /// (reason 2).
    function _feeGateDriftedVault(
        uint256 roundTrips,
        uint256 chunkUsdc
    ) private returns (MasonrySquareUsdcVault vault) {
        vault = _squareVaultAtTarget();
        vault.setFeeGateParams(24 hours, 24 hours, 10_000);
        uint256 t0 = block.timestamp;
        _depositSquare(vault, 4e16);
        _warmSquareOracle();
        _generateSquareVolume(roundTrips, chunkUsdc);
        vm.warp(t0 + 24 hours);
        _depositSquare(vault, 1e15);
        assertEq(vault.feeGateLastAt() - vault.feeGatePrevAt(), 24 hours);
        _warmSquareOracle();
        _driveSquareUp(vault);
        (bool eligible, uint8 reason) = vault.rebalanceNeeded();
        assertTrue(eligible);
        assertEq(reason, 2);
    }

    function testFeeGateRefusesWhenFeesDoNotCoverCost() public {
        // One small round trip over the 24h window: the position's
        // projected fees are a few dollars, the drift recenter's swap
        // leg costs tens — the recenter is refused, with NO state
        // change, even though the trigger says eligible.
        MasonrySquareUsdcVault vault = _feeGateDriftedVault(1, 2_000e6);
        int24 lowerBefore = vault.tickLower();
        int24 upperBefore = vault.tickUpper();
        uint256 liquidityBefore = vault.totalPositionLiquidity();
        vm.prank(KEEPER);
        (bool ok, bytes memory data) = address(vault).call(abi.encodeCall(MasonryUsdcVault.rebalance, ()));
        assertFalse(ok);
        assertEq(bytes4(data), MasonryUsdcVault.NotCostEffective.selector);
        // The refusal encodes a real estimate against a real required
        // threshold: some fees were projected, but they do not cover
        // the leg cost at a 100% margin.
        (uint256 expectedFees, uint256 requiredFees) = abi.decode(_afterSelector(data), (uint256, uint256));
        assertGt(expectedFees, 0);
        assertLt(expectedFees, requiredFees);
        assertEq(vault.tickLower(), lowerBefore);
        assertEq(vault.tickUpper(), upperBefore);
        assertEq(vault.totalPositionLiquidity(), liquidityBefore);
        assertEq(vault.lastRebalanceAt(), 0);
        // Eligibility is not consumed by the refusal: at a 1% margin
        // (an admin decision to wave this recenter through) the same
        // state recenters immediately.
        (bool eligible,) = vault.rebalanceNeeded();
        assertTrue(eligible);
        vault.setFeeGateParams(24 hours, 24 hours, 100);
        vm.prank(KEEPER);
        vault.rebalance();
        assertTrue(vault.lastRebalanceAt() != 0);
        assertTrue(vault.tickLower() != lowerBefore);
    }

    function testFeeGateRefusesWithoutFeeHistory() public {
        // Fail closed: a fresh vault driven eligible within its first
        // window has no completed observation pair, so the estimate is
        // zero and any costly recenter is refused.
        MasonrySquareUsdcVault vault = _squareVaultAtTarget();
        vault.setFeeGateParams(24 hours, 24 hours, 10_000);
        _depositSquare(vault, 4e16);
        _warmSquareOracle();
        _driveSquareUp(vault);
        (bool eligible, uint8 reason) = vault.rebalanceNeeded();
        assertTrue(eligible);
        assertEq(reason, 2);
        assertEq(vault.feeGatePrevAt(), 0);
        vm.prank(KEEPER);
        (bool ok, bytes memory data) = address(vault).call(abi.encodeCall(MasonryUsdcVault.rebalance, ()));
        assertFalse(ok);
        assertEq(bytes4(data), MasonryUsdcVault.NotCostEffective.selector);
        // The estimate encoded in the refusal is exactly zero: no
        // completed observation pair exists to project from.
        (uint256 expectedFees, uint256 requiredFees) = abi.decode(_afterSelector(data), (uint256, uint256));
        assertEq(expectedFees, 0);
        assertGt(requiredFees, 0);
        assertEq(vault.lastRebalanceAt(), 0);
        // The margin-0 off-switch is an explicit admin decision: with
        // the gate off, the same state recenters.
        vault.setFeeGateParams(24 hours, 24 hours, 0);
        vm.prank(KEEPER);
        vault.rebalance();
        assertTrue(vault.lastRebalanceAt() != 0);
    }

    function testFeeGateAllowsWhenFeesCoverCost() public {
        // Twenty-five $20k round trips over the window: roughly $1M
        // of volume, ~$3k of pool fees — the projected take for a
        // position of this size clears the leg cost several times
        // over and the same drift state recenters.
        MasonrySquareUsdcVault vault = _feeGateDriftedVault(25, 20_000e6);
        (int24 twapTick,, bool twapValid) = vault.currentTwapTick();
        assertTrue(twapValid);
        vm.prank(KEEPER);
        vault.rebalance();
        assertApproxEqAbs(vault.tickLower(), twapTick - 1800, 60);
        assertApproxEqAbs(vault.tickUpper(), twapTick + 1000, 60);
        assertTrue(vault.lastRebalanceAt() != 0);
    }

    function testFeeGateParamsAdminSurface() public {
        // Deployed raw (no factory) so the constructor defaults are
        // what the getters report.
        MasonrySquareUsdcVault vault = new MasonrySquareUsdcVault(
            squareKey, midpoint - 1800, midpoint + 1020, squareGuard, router, defense, address(this)
        );
        // Constructor defaults are the production shape.
        assertEq(vault.feeGateHorizon(), 24 hours);
        assertEq(vault.feeGateWindow(), 24 hours);
        assertEq(vault.feeGateMarginBps(), 10_000);
        // A valid update applies and emits.
        vm.expectEmit(false, false, false, true, address(vault));
        emit MasonryUsdcVault.FeeGateParamsUpdated(48 hours, 12 hours, 5_000);
        vault.setFeeGateParams(48 hours, 12 hours, 5_000);
        assertEq(vault.feeGateHorizon(), 48 hours);
        assertEq(vault.feeGateWindow(), 12 hours);
        assertEq(vault.feeGateMarginBps(), 5_000);
        // Validation: every bound rejects.
        vm.expectRevert(MasonryUsdcVault.InvalidParameters.selector);
        vault.setFeeGateParams(0, 12 hours, 5_000);
        vm.expectRevert(MasonryUsdcVault.InvalidParameters.selector);
        vault.setFeeGateParams(31 days, 12 hours, 5_000);
        vm.expectRevert(MasonryUsdcVault.InvalidParameters.selector);
        vault.setFeeGateParams(48 hours, 0, 5_000);
        vm.expectRevert(MasonryUsdcVault.InvalidParameters.selector);
        vault.setFeeGateParams(48 hours, 8 days, 5_000);
        vm.expectRevert(MasonryUsdcVault.InvalidParameters.selector);
        vault.setFeeGateParams(48 hours, 12 hours, 100_001);
        // Owner only.
        vm.prank(STRANGER);
        vm.expectRevert();
        vault.setFeeGateParams(48 hours, 12 hours, 5_000);
    }

}
