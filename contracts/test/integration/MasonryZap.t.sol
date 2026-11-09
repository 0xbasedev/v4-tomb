// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "v4-core/src/PoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {MasonryCriticalDefense} from "../../src/masonry/MasonryCriticalDefense.sol";
import {MasonryLevelOracle} from "../../src/masonry/MasonryLevelOracle.sol";
import {MasonryTaxHook} from "../../src/hooks/MasonryTaxHook.sol";
import {MasonrySquareHook} from "../../src/hooks/MasonrySquareHook.sol";
import {MasonryGenesisSchedule} from "../../src/masonry/MasonryGenesisSchedule.sol";
import {MockMasonryLevel, MockMasonryUSDC} from "../unit/MasonryGenesisLPBurnFee.t.sol";
import {MasonrySquareUsdcVault} from "../../src/masonry/MasonrySquareUsdcVault.sol";
import {MasonryLevelUsdcVault} from "../../src/masonry/MasonryLevelUsdcVault.sol";
import {MiniSwapRouter} from "../../src/swap/MiniSwapRouter.sol";
import {MasonryZap} from "../../src/masonry/MasonryZap.sol";
import {MasonryGenesisPass} from "../../src/masonry/MasonryGenesisPass.sol";
import {
    MasonryGenesisLPBurnFee,
    IMasonryBurnableLevel,
    IMasonryExactInputV4Router
} from "../../src/masonry/MasonryGenesisLPBurnFee.sol";
import {MasonryBuybackGuard} from "../../src/masonry/MasonryBuybackGuard.sol";
import {MasonryGenesisStaking, IMasonryGenesisSettlement} from "../../src/masonry/MasonryGenesisStaking.sol";
import {ShareRewardPool} from "../../src/distribution/ShareRewardPool.sol";
import {Boardroom} from "../../src/core/Boardroom.sol";
import {ITreasury} from "../../src/interfaces/ITreasury.sol";
import {MockTwapLevelHook, IMockLevelTwap} from "./MasonryLevelHook.t.sol";
import {HookMiner} from "../utils/HookMiner.sol";

/// @dev Settlement stand-in: GenesisStaking only calls settle() on
/// claim/compound paths, which these tests never reach.
contract MockZapSettlement is IMasonryGenesisSettlement {
    function settle(
        address,
        uint256,
        bool,
        bool,
        IMasonryGenesisSettlement.CompoundPlan calldata
    ) external {}
}

/// @dev Treasury stand-in for the Boardroom: a fixed epoch so tests can
/// prove the zap stake starts the same loyalty clock as a manual stake.
contract MockZapTreasury {
    function epoch() external pure returns (uint256) {
        return 7;
    }

    function nextEpochPoint() external view returns (uint256) {
        return block.timestamp + 6 hours;
    }

    function getMoneyPrice() external pure returns (uint256) {
        return 1e18;
    }
}

/// @notice MasonryZap v3 against the real hooked pools, both real vaults
/// and the real staking stack. Every staking route must end STAKED for
/// the user (ZapBase's zapAndStake), the swap route must convert at the
/// simulated rate, the house toll is taken exactly once at 0.5% (Genesis
/// LP route exempt — its toll is the pool-1 burn fee), protection reverts
/// leave the user whole, and no dust ever strands in the zap.
contract MasonryZapTest is Test, IMockLevelTwap {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    MockMasonryLevel private level;
    MockMasonryLevel private square;
    MockMasonryUSDC private usdc;
    MasonryGenesisSchedule private schedule;
    MockTwapLevelHook private hook;
    MasonrySquareHook private squareHook;
    PoolModifyLiquidityTest private liquidity;
    PoolKey private key;
    PoolKey private squareKey;
    MiniSwapRouter private router;
    MasonryLevelUsdcVault private vault;
    MasonrySquareUsdcVault private squareVault;
    MasonryGenesisPass private pass;
    MasonryGenesisLPBurnFee private burnFee;
    MasonryGenesisStaking private staking;
    ShareRewardPool private farm;
    Boardroom private boardroom;
    MasonryZap private zap;

    address private user;
    address private user2;
    address private noPass;
    address private constant TREASURY = address(0x777);
    address private constant FEE_RECIPIENT = address(0xFEE);
    uint256 private constant USER_USDC = 100_000e6;
    uint256 private constant ZAP_IN = 1_000e6;

    function mockTwapSettings() external pure returns (uint256, bool) {
        return (1e18, true);
    }

    function setUp() public {
        level = new MockMasonryLevel();
        usdc = new MockMasonryUSDC();
        schedule = new MasonryGenesisSchedule(block.timestamp + 1 days, address(this));
        PoolManager manager = new PoolManager(address(this));
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
        bool level0 = address(level) < address(usdc);
        uint160 peg = uint160(level0 ? (uint256(1) << 96) / 1e6 : (uint256(1) << 96) * 1e6);
        manager.initialize(key, peg);
        level.mint(address(this), 1_000_000e18);
        usdc.mint(address(this), 1_000_000e6);
        level.approve(address(liquidity), type(uint256).max);
        usdc.approve(address(liquidity), type(uint256).max);
        int24 tick = TickMath.getTickAtSqrtPrice(peg);
        int24 center = tick / 60 * 60;
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(center - 6000, center + 6000, 1e16, 0), "");
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(center - 120, center + 120, 1e16, 0), "");

        router = new MiniSwapRouter(manager);
        vault = new MasonryLevelUsdcVault(key, center - 6000, center + 6000);
        _squarePool(manager);
        _stakingStack();

        user = makeAddr("user");
        user2 = makeAddr("user2");
        noPass = makeAddr("noPass");
        _fundUser(user, MasonryGenesisPass.Tier.Pro);
        _fundUser(user2, MasonryGenesisPass.Tier.Genesis);
        usdc.mint(noPass, USER_USDC);
        vm.prank(noPass);
        usdc.approve(address(zap), type(uint256).max);
    }

    /// @dev The full staking stack + the zap, wired the way the config
    /// template prescribes: staking contracts first, zap last, then the
    /// zap allowlisted as beneficiary-staking operator on all three.
    function _stakingStack() private {
        MasonryBuybackGuard guard = new MasonryBuybackGuard(key, 150, 100, 150);
        burnFee = new MasonryGenesisLPBurnFee(
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
        pass = new MasonryGenesisPass(IERC20Metadata(address(usdc)), TREASURY, schedule);
        staking = new MasonryGenesisStaking(
            pass, burnFee, new MockZapSettlement(), IERC20(address(usdc)), 30_000e18
        );
        burnFee.setGenesis(address(staking));
        level.approve(address(staking), 30_000e18);
        staking.fund();

        farm = new ShareRewardPool(address(square), block.timestamp + 1, address(this));
        square.mint(address(farm), 59_500e18);
        farm.add(7500, IERC20(address(vault)), false, 0);
        farm.add(2000, IERC20(address(squareVault)), false, 0);

        boardroom = new Boardroom(address(this));
        boardroom.initialize(
            IERC20(address(level)), IERC20(address(square)), ITreasury(address(new MockZapTreasury()))
        );

        zap = new MasonryZap(
            address(router),
            address(usdc),
            address(vault),
            address(squareVault),
            address(staking),
            address(farm),
            address(boardroom),
            FEE_RECIPIENT,
            50,
            address(this)
        );
        staking.setZapOperator(address(zap));
        farm.setZapOperator(address(zap));
        boardroom.setZapOperator(address(zap));
    }

    function _fundUser(
        address who,
        MasonryGenesisPass.Tier tier
    ) private {
        usdc.mint(who, USER_USDC);
        vm.startPrank(who);
        usdc.approve(address(pass), type(uint256).max);
        pass.purchase(tier);
        usdc.approve(address(zap), type(uint256).max);
        vm.stopPrank();
    }

    function _warpIntoGenesis() private {
        vm.warp(schedule.start() + 2 days);
    }

    /* ------------------------------ routes end STAKED ------------------------------ */

    function testZapFarmLevelStakesAndFeeExactlyOnce() public {
        (, uint256 preview) = zap.previewZap(MasonryZap.Destination.FarmLevel, ZAP_IN);
        uint256 credited = _zapAs(1);
        assertGt(credited, 0, "nothing staked");
        (uint256 staked,) = farm.userInfo(0, user);
        assertEq(staked, credited, "farm position must equal the returned credit");
        // Solved-split quote equality: previewZap runs the same simulation
        // and deposit math the zap executes, so the credited stake lands
        // exactly on the quote (v1's spot quote landed ~86%).
        assertEq(credited, preview, "credited stake must equal the solved quote");
        assertEq(vault.balanceOf(user), 0, "shares must be staked, not delivered");
        assertEq(usdc.balanceOf(FEE_RECIPIENT), 5e6, "route fee must be exactly 0.5%, taken once");
        assertEq(usdc.balanceOf(user), USER_USDC - 100e6 - ZAP_IN, "out exactly the zap input (plus the Pro pass)");
        assertZapEmpty();
    }

    function testZapFarmShareStakes() public {
        (, uint256 preview) = zap.previewZap(MasonryZap.Destination.FarmShare, ZAP_IN);
        uint256 credited = _zapAs(2);
        (uint256 staked,) = farm.userInfo(1, user);
        assertEq(staked, credited);
        assertEq(credited, preview, "credited stake must equal the solved quote");
        assertEq(squareVault.balanceOf(user), 0, "shares must be staked, not delivered");
        assertEq(usdc.balanceOf(FEE_RECIPIENT), 5e6);
        assertZapEmpty();
    }

    function testZapGenesisLPStakesNetOfBurnFee() public {
        _warpIntoGenesis();
        (, uint256 preview) = zap.previewZap(MasonryZap.Destination.GenesisLP, ZAP_IN);
        uint256 credited = _zapAs(0);
        (uint256 shares,,) = staking.positions(1, user);
        assertEq(shares, credited, "pool 1 position must equal the returned credit");
        assertEq(credited, preview, "quote is net of the burn fee and must land exactly");
        assertGt(burnFee.totalFeeSharesCollected(), 0, "the one toll on this route is the burn fee");
        assertEq(usdc.balanceOf(FEE_RECIPIENT), 0, "Genesis LP route must pay no route fee");
        assertEq(vault.balanceOf(user), 0, "shares must be staked, not delivered");
        assertZapEmpty();
    }

    function testZapMasonryStakesInBoardroom() public {
        (, uint256 preview) = zap.previewZap(MasonryZap.Destination.Masonry, ZAP_IN);
        uint256 credited = _zapAs(3);
        assertGt(credited, 0);
        assertEq(boardroom.balanceOf(user), credited, "Boardroom stake must equal the returned credit");
        assertEq(credited, preview, "credited stake must equal the simulated quote");
        assertEq(square.balanceOf(user), 0, "xSHARE must be staked, not delivered");
        assertEq(usdc.balanceOf(FEE_RECIPIENT), 5e6);
        // The loyalty clock starts from the zap stake.
        (,, uint256 epochTimerStart) = boardroom.members(user);
        assertEq(epochTimerStart, 7, "epoch timer must start at the stake epoch");
        assertZapEmpty();
    }

    function testZapGenesisStandardStakesPool0() public {
        _warpIntoGenesis();
        // The pool's standard asset in this deployment IS the stable, so
        // the zap is a direct stake: input minus the route fee, credited
        // gross (pool 0 charges no deposit fee — hence the fee is due).
        (, uint256 preview) = zap.previewZap(MasonryZap.Destination.GenesisStandard, ZAP_IN);
        assertEq(preview, ZAP_IN - 5e6);
        vm.prank(user);
        uint256 credited = zap.zapToGenesisStandard(ZAP_IN, 0, block.timestamp + 1 hours);
        (uint256 shares,,) = staking.positions(0, user);
        assertEq(shares, ZAP_IN - 5e6, "pool 0 position must be the work amount");
        assertEq(credited, shares);
        assertEq(usdc.balanceOf(FEE_RECIPIENT), 5e6, "standard route pays the route fee exactly once");
        assertZapEmpty();
    }

    function testZapGenesisStandardSwapsWhenStandardIsAsset() public {
        // A second Genesis deployment whose pool 0 stakes xSHARE (a legal
        // configuration: anything but the reward token). The zap must
        // convert the stable on the Square pool at the simulated rate and
        // stake the proceeds — the swap-then-stake branch of the route.
        MasonryGenesisStaking staking2 = new MasonryGenesisStaking(
            pass, burnFee, new MockZapSettlement(), IERC20(address(square)), 30_000e18
        );
        level.approve(address(staking2), 30_000e18);
        staking2.fund();
        MasonryZap zap2 = new MasonryZap(
            address(router),
            address(usdc),
            address(vault),
            address(squareVault),
            address(staking2),
            address(farm),
            address(boardroom),
            FEE_RECIPIENT,
            50,
            address(this)
        );
        staking2.setZapOperator(address(zap2));
        assertEq(address(zap2.standardToken()), address(square));

        _warpIntoGenesis();
        (, uint256 preview) = zap2.previewZap(MasonryZap.Destination.GenesisStandard, ZAP_IN);
        assertGt(preview, 0);
        vm.startPrank(user);
        usdc.approve(address(zap2), type(uint256).max);
        uint256 credited = zap2.zapToGenesisStandard(ZAP_IN, 0, block.timestamp + 1 hours);
        vm.stopPrank();
        (uint256 shares,,) = staking2.positions(0, user);
        assertEq(shares, credited);
        assertEq(credited, preview, "converted stake must land on the simulated quote");
        assertEq(usdc.balanceOf(FEE_RECIPIENT), 5e6);
        assertEq(square.balanceOf(address(zap2)), 0);
        assertEq(usdc.balanceOf(address(zap2)), 0);
    }

    function testZapStandardAssetInputStakes() public {
        _warpIntoGenesis();
        vm.prank(user);
        uint256 credited = zap.zapAssetToGenesisStandard(ZAP_IN, 0, block.timestamp + 1 hours);
        (uint256 shares,,) = staking.positions(0, user);
        assertEq(shares, ZAP_IN - 5e6);
        assertEq(credited, shares);
        assertEq(usdc.balanceOf(FEE_RECIPIENT), 5e6, "fee is taken in the input (standard) asset");
        assertZapEmpty();
    }

    function testZapDirectVaultSharesStake() public {
        // The input already IS the farm's stake asset: no conversion, fee
        // taken in the shares, the rest staked for the caller.
        vm.startPrank(user);
        level.mint(user, 400e18);
        level.approve(address(vault), type(uint256).max);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(5e14, type(uint256).max, type(uint256).max, user);
        uint256 sharesHeld = vault.balanceOf(user);
        IERC20(address(vault)).approve(address(zap), type(uint256).max);
        uint256 credited = zap.zap(address(vault), sharesHeld, MasonryZap.Destination.FarmLevel, 0, block.timestamp + 1 hours);
        vm.stopPrank();
        uint256 feeShares = sharesHeld * 50 / 10_000;
        assertEq(credited, sharesHeld - feeShares);
        (uint256 staked,) = farm.userInfo(0, user);
        assertEq(staked, credited);
        assertEq(vault.balanceOf(FEE_RECIPIENT), feeShares, "fee taken in the input asset");
        assertZapEmpty();
    }

    /* ------------------------------ fill rate (the ≥99% bar) ------------------------------ */

    function testZapFillThinFarmLevel() public {
        _assertFillLevel(user);
    }

    function testZapFillThinFarmShare() public {
        uint256 usdcBefore = usdc.balanceOf(user);
        uint256 assetBefore = square.balanceOf(user);
        _zapAs(2);
        _assertResidualAmount(user, usdcBefore, assetBefore, square, squareKey, ZAP_IN);
    }

    function testZapFillThinGenesisLP() public {
        _warpIntoGenesis();
        uint256 usdcBefore = usdc.balanceOf(user);
        uint256 assetBefore = level.balanceOf(user);
        vm.prank(user);
        zap.zapToGenesisLP(ZAP_IN, 0, block.timestamp + 1 hours);
        _assertResidualAmount(user, usdcBefore, assetBefore, level, key, ZAP_IN);
    }

    function testZapFillDeepLiquidity() public {
        // A 100x deeper book on the same range: the solved split must
        // hold the fill there too.
        int24 tick = TickMath.getTickAtSqrtPrice(_sqrtPrice(key));
        int24 center = tick / 60 * 60;
        liquidity.modifyLiquidity(key, ModifyLiquidityParams(center - 6000, center + 6000, 1e18, 0), "");
        _assertFillLevel(user);
    }

    function testZapFillWithFeeReserves() public {
        // Seed vault supply, generate pool fees with real swaps, then let
        // a dust deposit collect them into the vault's fee reserves — the
        // equalization top-up the solve must price in, not discover.
        _zapAs(1);
        usdc.approve(address(router), type(uint256).max);
        level.approve(address(router), type(uint256).max);
        router.swapExactIn(key, true, 300e6, 0, address(this));
        router.swapExactIn(key, false, 5e18, 0, address(this));
        level.approve(address(vault), type(uint256).max);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(1e12, type(uint256).max, type(uint256).max, address(this));
        assertGt(vault.feeReserve0() + vault.feeReserve1(), 0, "fixture must hold fee reserves");

        address fresh = makeAddr("fresh");
        usdc.mint(fresh, USER_USDC);
        vm.prank(fresh);
        usdc.approve(address(zap), type(uint256).max);
        _assertFillLevel(fresh);
    }

    /// forge-config: default.fuzz.runs = 24
    function testFuzz_ZapFarmLevelFill(
        uint256 amountIn
    ) public {
        // Bounded by the fixture's depth: the seeded book holds only a
        // few thousand dollars of value, and no zap can invest funds the
        // pool cannot absorb — the >=99% bar is a statement about inputs
        // the pool can price, so the property ranges over those.
        amountIn = bound(amountIn, 1e6, 3_000e6);
        uint256 usdcBefore = usdc.balanceOf(user);
        uint256 assetBefore = level.balanceOf(user);
        vm.prank(user);
        uint256 credited = zap.zapToFarmLevel(amountIn, 0, block.timestamp + 1 hours);
        assertGt(credited, 0);
        _assertResidualAmount(user, usdcBefore, assetBefore, level, key, amountIn);
        assertZapEmpty();
    }

    function _assertFillLevel(
        address who
    ) private {
        uint256 usdcBefore = usdc.balanceOf(who);
        uint256 assetBefore = level.balanceOf(who);
        vm.prank(who);
        zap.zapToFarmLevel(ZAP_IN, 0, block.timestamp + 1 hours);
        _assertResidualAmount(who, usdcBefore, assetBefore, level, key, ZAP_IN);
    }

    /// @dev Residual = what came back (stable refund + asset refund valued
    /// at the live pool price). The bar: under 1% of the zap input.
    function _assertResidualAmount(
        address who,
        uint256 usdcBefore,
        uint256 assetBefore,
        MockMasonryLevel asset,
        PoolKey memory poolKey_,
        uint256 amountIn
    ) private view {
        uint256 usdcRefund = usdc.balanceOf(who) - (usdcBefore - amountIn);
        uint256 assetRefund = asset.balanceOf(who) - assetBefore;
        bool assetIs0 = poolKey_.currency0 == Currency.wrap(address(asset));
        uint256 residual = usdcRefund + FullMath.mulDiv(assetRefund, _priceX18(poolKey_, assetIs0), 1e18);
        assertLt(residual * 100, amountIn, "residual refunds must stay under 1% of input");
    }

    /// @dev Spot price of the asset in the stable, raw units, scaled 1e18
    /// (mirrors the zap's own _priceX18).
    function _priceX18(
        PoolKey memory poolKey_,
        bool assetIs0
    ) private view returns (uint256) {
        uint256 sp = uint256(_sqrtPrice(poolKey_));
        if (assetIs0) {
            uint256 priceX96 = FullMath.mulDiv(sp, sp, uint256(1) << 96);
            return FullMath.mulDiv(priceX96, 1e18, uint256(1) << 96);
        }
        uint256 invSqrtX96 = FullMath.mulDiv(uint256(1) << 96, uint256(1) << 96, sp);
        uint256 invPriceX96 = FullMath.mulDiv(invSqrtX96, invSqrtX96, uint256(1) << 96);
        return FullMath.mulDiv(invPriceX96, 1e18, uint256(1) << 96);
    }

    function _sqrtPrice(
        PoolKey memory poolKey_
    ) private view returns (uint160 sqrtPrice) {
        (sqrtPrice,,,) = router.poolManager().getSlot0(poolKey_.toId());
    }

    /* ------------------------------ swap route ------------------------------ */

    function testSwapUsdcToLevelExact() public {
        (, uint256 expected) = zap.previewSwap(address(usdc), ZAP_IN, address(level));
        vm.prank(user);
        uint256 out = zap.swap(address(usdc), ZAP_IN, address(level), 0, block.timestamp + 1 hours);
        assertEq(out, expected, "buy must land exactly on the simulated quote");
        assertEq(level.balanceOf(user), out);
        assertEq(usdc.balanceOf(FEE_RECIPIENT), 5e6, "swap charges the route fee in the input");
        assertZapEmpty();
    }

    function testSwapLevelToUsdcSell() public {
        level.mint(user, 100e18);
        vm.prank(user);
        level.approve(address(zap), type(uint256).max);
        (uint256 fee, uint256 grossOut) = zap.previewSwap(address(level), 50e18, address(usdc));
        assertEq(fee, 25e16, "0.5% of the level input");
        uint256 minOut = grossOut * 90 / 100;
        vm.prank(user);
        uint256 out = zap.swap(address(level), 50e18, address(usdc), minOut, block.timestamp + 1 hours);
        assertGe(out, minOut, "measured receipt must clear the caller's floor");
        assertLt(out, grossOut, "the fire tax + LP fee come out of the gross quote");
        assertEq(usdc.balanceOf(user), USER_USDC - 100e6 + out);
        assertEq(level.balanceOf(FEE_RECIPIENT), fee);
        assertZapEmpty();
    }

    function testSwapLevelToSquareBridged() public {
        level.mint(user, 100e18);
        vm.prank(user);
        level.approve(address(zap), type(uint256).max);
        (, uint256 preview) = zap.previewSwap(address(level), 20e18, address(square));
        uint256 minOut = preview * 80 / 100;
        vm.prank(user);
        uint256 out = zap.swap(address(level), 20e18, address(square), minOut, block.timestamp + 1 hours);
        assertGe(out, minOut);
        assertEq(square.balanceOf(user), out);
        assertZapEmpty();
    }

    function testSwapMinOutRevertsWhole() public {
        (, uint256 expected) = zap.previewSwap(address(usdc), ZAP_IN, address(level));
        vm.prank(user);
        vm.expectRevert();
        zap.swap(address(usdc), ZAP_IN, address(level), expected + 1, block.timestamp + 1 hours);
        assertEq(usdc.balanceOf(user), USER_USDC - 100e6, "only the pass purchase is spent");
        assertEq(usdc.balanceOf(FEE_RECIPIENT), 0);
    }

    function testSwapUnpriceableReverts() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(MasonryZap.UnsupportedOutput.selector, address(0xDEAD)));
        zap.swap(address(usdc), ZAP_IN, address(0xDEAD), 0, block.timestamp + 1 hours);
    }

    /* ------------------------------ operator gating & tier gates ------------------------------ */

    function testZapOperatorGating() public {
        assertEq(staking.zapOperator(), address(zap));
        assertEq(farm.zapOperator(), address(zap));
        assertEq(boardroom.zapOperator(), address(zap));

        address stranger = makeAddr("stranger");
        vm.startPrank(stranger);
        vm.expectRevert(MasonryGenesisStaking.NotZapOperator.selector);
        staking.depositFor(0, 1, stranger);
        vm.expectRevert(ShareRewardPool.NotZapOperator.selector);
        farm.depositFor(0, 1, stranger);
        vm.expectRevert();
        boardroom.stakeFor(stranger, 1);
        vm.stopPrank();
    }

    function testZapOperatorRotationRevokes() public {
        boardroom.setZapOperator(address(0xBEEF));
        vm.prank(user);
        vm.expectRevert();
        zap.zapToMasonry(ZAP_IN, 0, block.timestamp + 1 hours);
        assertEq(usdc.balanceOf(user), USER_USDC - 100e6, "a revoked zap leaves the user whole (pass aside)");
        assertEq(usdc.balanceOf(FEE_RECIPIENT), 0);
    }

    function testZapGenesisStandardRequiresPass() public {
        _warpIntoGenesis();
        vm.prank(noPass);
        vm.expectRevert(MasonryGenesisStaking.NotEligible.selector);
        zap.zapToGenesisStandard(ZAP_IN, 0, block.timestamp + 1 hours);
        assertEq(usdc.balanceOf(noPass), USER_USDC, "gated beneficiary stays whole");
        assertEq(usdc.balanceOf(FEE_RECIPIENT), 0);
    }

    function testZapGenesisLPClosedBeforeLpOpen() public {
        vm.prank(user);
        vm.expectRevert(MasonryGenesisStaking.PoolClosed.selector);
        zap.zapToGenesisLP(ZAP_IN, 0, block.timestamp + 1 hours);
        assertEq(usdc.balanceOf(user), USER_USDC - 100e6, "only the pass purchase is spent");
    }

    function testZapUnsupportedInputsRevert() public {
        vm.startPrank(user);
        vm.expectRevert(abi.encodeWithSelector(MasonryZap.UnsupportedInput.selector, address(level)));
        zap.zap(address(level), 1e18, MasonryZap.Destination.FarmLevel, 0, block.timestamp + 1 hours);
        vm.expectRevert(abi.encodeWithSelector(MasonryZap.UnsupportedInput.selector, address(level)));
        zap.zap(address(level), 1e18, MasonryZap.Destination.GenesisStandard, 0, block.timestamp + 1 hours);
        vm.stopPrank();
    }

    /* ------------------------------ zap ≡ manual equivalence ------------------------------ */

    function testZapStandardEqualsManualDeposit() public {
        _warpIntoGenesis();
        vm.prank(user);
        uint256 credited = zap.zapToGenesisStandard(ZAP_IN, 0, block.timestamp + 1 hours);
        vm.startPrank(user2);
        usdc.approve(address(staking), type(uint256).max);
        staking.deposit(0, credited);
        vm.stopPrank();
        (uint256 zapShares,,) = staking.positions(0, user);
        (uint256 manualShares,,) = staking.positions(0, user2);
        assertEq(zapShares, manualShares, "a zap stake is indistinguishable from a manual one");
    }

    function testZapMasonryInputEqualsManualStake() public {
        square.mint(user, 100e18);
        square.mint(user2, 100e18);
        vm.prank(user);
        square.approve(address(zap), type(uint256).max);
        vm.prank(user);
        uint256 credited = zap.zap(address(square), 100e18, MasonryZap.Destination.Masonry, 0, block.timestamp + 1 hours);
        vm.roll(block.number + 1); // the Boardroom's one-block guard spans all stakers
        vm.startPrank(user2);
        square.approve(address(boardroom), type(uint256).max);
        boardroom.stake(credited);
        vm.stopPrank();
        assertEq(boardroom.balanceOf(user), boardroom.balanceOf(user2));
        (,, uint256 zapTimer) = boardroom.members(user);
        (,, uint256 manualTimer) = boardroom.members(user2);
        assertEq(zapTimer, manualTimer, "loyalty clocks start identically");
        assertEq(zapTimer, 7);
    }

    /* ------------------------------ protection ------------------------------ */

    function testZapExpiredDeadlineReverts() public {
        vm.prank(user);
        vm.expectRevert(MasonryZap.Expired.selector);
        zap.zapToFarmLevel(ZAP_IN, 0, block.timestamp - 1);
        assertEq(usdc.balanceOf(user), USER_USDC - 100e6, "only the pass purchase is spent");
        assertEq(usdc.balanceOf(FEE_RECIPIENT), 0);
    }

    function testZapZeroAmountReverts() public {
        vm.prank(user);
        vm.expectRevert(MasonryZap.InvalidAmount.selector);
        zap.zapToFarmShare(0, 0, block.timestamp + 1 hours);
    }

    function testZapMinSharesRevertLeavesUserWhole() public {
        uint256 credited = _zapAs(1);
        uint256 usdcAfterFirst = usdc.balanceOf(user);
        vm.prank(user);
        try zap.zapToFarmLevel(ZAP_IN, credited + 1, block.timestamp + 1 hours) {
            revert("zap above the attainable share count must revert");
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), MasonryZap.BelowMinShares.selector, "wrong revert");
        }
        assertEq(usdc.balanceOf(user), usdcAfterFirst);
        (uint256 staked,) = farm.userInfo(0, user);
        assertEq(staked, credited, "the first stake is untouched");
        assertEq(usdc.balanceOf(FEE_RECIPIENT), 5e6, "a reverted zap must not take a second fee");
        assertZapEmpty();
    }

    /* ------------------------------ admin ------------------------------ */

    function testZapAdminSurface() public {
        assertEq(zap.routeFeeBps(), 50);
        assertEq(zap.feeRecipient(), FEE_RECIPIENT);

        zap.setRouteFeeBps(100);
        assertEq(zap.routeFeeBps(), 100);
        uint256 credited = _zapAs(1);
        assertGt(credited, 0);
        assertEq(usdc.balanceOf(FEE_RECIPIENT), 10e6, "updated 1% fee must apply exactly");

        vm.expectRevert(MasonryZap.InvalidFee.selector);
        zap.setRouteFeeBps(501);
        vm.expectRevert(MasonryZap.InvalidConfiguration.selector);
        zap.setFeeRecipient(address(0));

        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert();
        zap.setRouteFeeBps(25);
        vm.prank(stranger);
        vm.expectRevert();
        zap.setFeeRecipient(stranger);
    }

    function testZapPreviewQuotesFeePerRoute() public {
        (uint256 farmFee, uint256 farmShares) = zap.previewZap(MasonryZap.Destination.FarmLevel, ZAP_IN);
        assertEq(farmFee, 5e6);
        assertGt(farmShares, 0);
        (uint256 genesisFee,) = zap.previewZap(MasonryZap.Destination.GenesisLP, ZAP_IN);
        assertEq(genesisFee, 0);
        (uint256 masonryFee, uint256 masonryOut) = zap.previewZap(MasonryZap.Destination.Masonry, ZAP_IN);
        assertEq(masonryFee, 5e6);
        assertGt(masonryOut, 0);
    }

    /* ------------------------------ helpers ------------------------------ */

    function _zapAs(
        uint8 route
    ) private returns (uint256) {
        vm.prank(user);
        uint256 deadline = block.timestamp + 1 hours;
        if (route == 0) return zap.zapToGenesisLP(ZAP_IN, 0, deadline);
        if (route == 1) return zap.zapToFarmLevel(ZAP_IN, 0, deadline);
        if (route == 2) return zap.zapToFarmShare(ZAP_IN, 0, deadline);
        return zap.zapToMasonry(ZAP_IN, 0, deadline);
    }

    function assertZapEmpty() private view {
        assertEq(usdc.balanceOf(address(zap)), 0, "stable stranded in the zap");
        assertEq(level.balanceOf(address(zap)), 0, "level stranded in the zap");
        assertEq(square.balanceOf(address(zap)), 0, "square stranded in the zap");
        assertEq(vault.balanceOf(address(zap)), 0, "level shares stranded in the zap");
        assertEq(squareVault.balanceOf(address(zap)), 0, "square shares stranded in the zap");
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

    function _squarePool(
        PoolManager manager
    ) private {
        square = new MockMasonryLevel();
        MasonryCriticalDefense defense = new MasonryCriticalDefense(hook.oracle());
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
        bool square0 = squareHook.assetIsCurrency0();
        uint160 peg = uint160(square0 ? (uint256(1) << 96) / 1e6 : (uint256(1) << 96) * 1e6);
        manager.initialize(squareKey, peg);
        square.mint(address(this), 1_000_000e18);
        square.approve(address(liquidity), type(uint256).max);
        int24 midpoint = TickMath.getTickAtSqrtPrice(peg) / 60 * 60;
        liquidity.modifyLiquidity(squareKey, ModifyLiquidityParams(midpoint - 6000, midpoint + 6000, 1e16, 0), "");
        squareVault = new MasonrySquareUsdcVault(squareKey, midpoint - 6000, midpoint + 6000);
    }
}
