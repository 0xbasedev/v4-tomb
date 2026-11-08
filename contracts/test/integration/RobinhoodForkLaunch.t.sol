// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";

import {HookMiner} from "../utils/HookMiner.sol";
import {MasonryTaxHook} from "../../src/hooks/MasonryTaxHook.sol";
import {MasonryLevelHook} from "../../src/hooks/MasonryLevelHook.sol";
import {MasonryLevelOracle} from "../../src/masonry/MasonryLevelOracle.sol";
import {MasonryGenesisSchedule} from "../../src/masonry/MasonryGenesisSchedule.sol";
import {MasonryGenesisPass} from "../../src/masonry/MasonryGenesisPass.sol";
import {MasonryGenesisStaking, IMasonryGenesisSettlement} from "../../src/masonry/MasonryGenesisStaking.sol";
import {
    MasonryGenesisLPBurnFee,
    IMasonryBurnableLevel,
    IMasonryRedeemableLPVault,
    IMasonryExactInputV4Router,
    IMasonryBuybackExecutionGuard
} from "../../src/masonry/MasonryGenesisLPBurnFee.sol";
import {MasonryCriticalDefense, IMasonryValidatedLevelTwap} from "../../src/masonry/MasonryCriticalDefense.sol";
import {MasonryRules} from "../../src/masonry/MasonryRules.sol";
import {IMasonryMintableLevel} from "../../src/masonry/IMasonryRuntime.sol";
import {MasonryBond} from "../../src/masonry/MasonryBond.sol";
import {MasonryChamber} from "../../src/masonry/MasonryChamber.sol";
import {MasonryFarm} from "../../src/masonry/MasonryFarm.sol";
import {MasonryTreasury} from "../../src/masonry/MasonryTreasury.sol";
import {MasonryLaunchConfig, MasonryLaunchParams} from "../../script/MasonryLaunchConfig.sol";
import {MasonryRangeManager, IMasonryRangeTwap} from "../../src/masonry/MasonryRangeManager.sol";
import {MasonryLevelPrice} from "../../src/masonry/MasonryLevelPrice.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";

contract LaunchLevel is ERC20Burnable {
    constructor() ERC20("X Tomb", "xTOMB") {}

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract LaunchShare is ERC20 {
    constructor() ERC20("X Share", "xSHARE") {}

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract LaunchShareWethLp is ERC20 {
    constructor() ERC20("X Share/WETH LP", "xSHARE-WETH") {}

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract LaunchVault is ERC20, IMasonryRedeemableLPVault {
    IERC20 public immutable level;
    IERC20 public immutable usdc;
    PoolKey private key;

    constructor(
        IERC20 level_,
        IERC20 usdc_
    ) ERC20("LP", "LP") {
        level = level_;
        usdc = usdc_;
    }

    function setPoolKey(
        PoolKey memory key_
    ) external {
        key = key_;
    }

    function poolKey() external view returns (PoolKey memory) {
        return key;
    }

    function mintShares(
        address to,
        uint256 shares
    ) external {
        _mint(to, shares);
    }

    function redeem(
        uint256 shares,
        address to
    ) external returns (uint256 levelReceived, uint256 usdcReceived) {
        _burn(msg.sender, shares);
        levelReceived = shares / 2;
        usdcReceived = 0;
        level.transfer(to, levelReceived);
    }
}

contract LaunchGuard is IMasonryBuybackExecutionGuard {
    PoolId public officialPool;

    function setPoolKey(
        PoolKey memory key_
    ) external {
        officialPool = PoolIdLibrary.toId(key_);
    }

    function minimumLevelOut(
        uint256
    ) external pure returns (uint256) {
        return 1;
    }
}

contract LaunchRouter is IMasonryExactInputV4Router {
    function swapExactIn(
        PoolKey calldata,
        bool,
        uint256,
        uint256,
        address
    ) external pure returns (uint256) {
        revert("dry-run router unused");
    }
}

contract LaunchSettlement is IMasonryGenesisSettlement {
    IERC20 private immutable level;

    constructor(
        IERC20 level_
    ) {
        level = level_;
    }

    function settle(
        address beneficiary,
        uint256 reward,
        bool,
        bool,
        CompoundPlan calldata
    ) external {
        if (reward > 0) level.transfer(beneficiary, reward);
    }
}

contract MockTwapOracle is IMasonryValidatedLevelTwap {
    uint256 public price = 1e18;

    function latestValidatedTwap() external view returns (uint256, uint256, bool) {
        return (price, block.timestamp, true);
    }

    function setPrice(
        uint256 price_
    ) external {
        price = price_;
    }
}

/// @notice Local-only Masonry launch rehearsal against Robinhood mainnet infra.
/// Never broadcasts. Skips when the public RPC is unreachable.
contract RobinhoodForkLaunchTest is Test, ERC721Holder {
    using PoolIdLibrary for PoolKey;

    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    uint256 internal constant ROBINHOOD = 4663;

    bool internal forked;

    function setUp() public {
        try vm.createSelectFork("https://rpc.mainnet.chain.robinhood.com") {
            forked = block.chainid == ROBINHOOD && POOL_MANAGER.code.length > 0 && USDG.code.length > 0;
        } catch {
            forked = false;
        }
        if (!forked) return;
    }

    struct LivePool {
        LaunchLevel level;
        PoolKey key;
        PoolSwapTest swaps;
        bool level0;
    }

    function test_DryRunMasonryLaunchAgainstRobinhoodInfra() public {
        if (!forked) {
            vm.skip(true);
            return;
        }
        assertEq(IERC20Metadata(USDG).decimals(), 6, "USDG decimals");
        assertEq(IERC20Metadata(WETH).decimals(), 18, "WETH decimals");

        address treasury = address(0xA11CE);
        address user = address(0xB0B);
        vm.deal(user, 10 ether);
        deal(USDG, user, 10_000e6);
        deal(USDG, address(this), 2_000_000e6);

        MasonryGenesisSchedule schedule = new MasonryGenesisSchedule(0, address(this));
        MasonryGenesisPass pass = new MasonryGenesisPass(IERC20Metadata(USDG), treasury, schedule);
        schedule.schedule(block.timestamp + 2 days);
        pass.setSaleOpen(true);

        LivePool memory pool = _launchOfficialPool(schedule);
        _buyUltra(pass, user, treasury);
        _depositGenesis(pass, pool, user, schedule);
        _sellLevel(pool, user);

        MockTwapOracle twap = new MockTwapOracle();
        MasonryCriticalDefense defense = new MasonryCriticalDefense(twap);
        assertFalse(defense.sync());
        assertFalse(MasonryRules.eligibleForExpansion(1e18, 1e18, true));
        assertTrue(MasonryRules.eligibleForExpansion(1.02e18, 1e18, true));
        _wireModernRuntime(pool.level, twap, user);
        _exerciseRangeManagers(pool);
    }

    function _launchOfficialPool(
        MasonryGenesisSchedule schedule
    ) internal returns (LivePool memory pool) {
        pool.level = new LaunchLevel();
        pool.swaps = new PoolSwapTest(IPoolManager(POOL_MANAGER));
        pool.level0 = address(pool.level) < USDG;
        (address expected, bytes32 salt, MasonryTaxHook.OracleConfig memory oracleConfig) =
            _mineHook(schedule, pool.level);
        pool.key = PoolKey({
            currency0: Currency.wrap(pool.level0 ? address(pool.level) : USDG),
            currency1: Currency.wrap(pool.level0 ? USDG : address(pool.level)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(expected)
        });
        assertEq(
            address(new MasonryLevelOracle(pool.key.toId(), pool.level0, 1e15, expected)), address(oracleConfig.oracle)
        );
        assertEq(address(_deployHook(schedule, oracleConfig, address(pool.level), salt)), expected);
        _seedPool(pool);
    }

    function _mineHook(
        MasonryGenesisSchedule schedule,
        LaunchLevel level
    ) internal view returns (address expected, bytes32 salt, MasonryTaxHook.OracleConfig memory oracleConfig) {
        uint160 flags = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_ADD_LIQUIDITY_FLAG
            | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG;
        oracleConfig = MasonryTaxHook.OracleConfig(
            MasonryLevelOracle(vm.computeCreateAddress(address(this), vm.getNonce(address(this)))), address(this)
        );
        (expected, salt) = HookMiner.find(
            address(this),
            flags,
            bytes.concat(
                type(MasonryLevelHook).creationCode,
                abi.encode(
                    IPoolManager(POOL_MANAGER),
                    schedule,
                    oracleConfig,
                    level,
                    USDG,
                    address(0xA11CE),
                    uint24(3000),
                    int24(60)
                )
            )
        );
    }

    function _deployHook(
        MasonryGenesisSchedule schedule,
        MasonryTaxHook.OracleConfig memory oracleConfig,
        address level,
        bytes32 salt
    ) internal returns (MasonryLevelHook hook) {
        hook = new MasonryLevelHook{salt: salt}(
            IPoolManager(POOL_MANAGER), schedule, oracleConfig, level, USDG, address(0xA11CE), 3000, 60
        );
    }

    function _seedPool(
        LivePool memory pool
    ) internal {
        uint160 peg = uint160(pool.level0 ? (uint256(1) << 96) / 1e6 : (uint256(1) << 96) * 1e6);
        IPoolManager(POOL_MANAGER).initialize(pool.key, peg);
        PoolModifyLiquidityTest liquidity = new PoolModifyLiquidityTest(IPoolManager(POOL_MANAGER));
        pool.level.mint(address(this), 2_000_000e18);
        pool.level.approve(address(liquidity), type(uint256).max);
        IERC20(USDG).approve(address(liquidity), type(uint256).max);
        pool.level.approve(address(pool.swaps), type(uint256).max);
        IERC20(USDG).approve(address(pool.swaps), type(uint256).max);
        int24 center = TickMath.getTickAtSqrtPrice(peg) / 60 * 60;
        liquidity.modifyLiquidity(pool.key, ModifyLiquidityParams(center - 6000, center + 6000, 1e16, 0), "");
    }

    function _buyUltra(
        MasonryGenesisPass pass,
        address user,
        address treasury
    ) internal {
        vm.startPrank(user);
        IERC20(USDG).approve(address(pass), 500e6);
        uint256 tokenId = pass.purchase(MasonryGenesisPass.Tier.Ultra);
        vm.stopPrank();
        assertEq(tokenId, 1);
        assertEq(uint8(pass.tierOf(user)), uint8(MasonryGenesisPass.Tier.Ultra));
        assertEq(IERC20(USDG).balanceOf(treasury), 500e6);
    }

    function _depositGenesis(
        MasonryGenesisPass pass,
        LivePool memory pool,
        address user,
        MasonryGenesisSchedule schedule
    ) internal {
        LaunchVault vault = new LaunchVault(IERC20(address(pool.level)), IERC20(USDG));
        LaunchGuard guard = new LaunchGuard();
        vault.setPoolKey(pool.key);
        guard.setPoolKey(pool.key);
        MasonryGenesisLPBurnFee lpFee = new MasonryGenesisLPBurnFee(
            IMasonryRedeemableLPVault(address(vault)),
            IMasonryBurnableLevel(address(pool.level)),
            IERC20(USDG),
            IMasonryExactInputV4Router(address(new LaunchRouter())),
            IMasonryBuybackExecutionGuard(address(guard)),
            pool.key,
            address(this),
            100e18,
            100e6,
            address(this)
        );
        MasonryGenesisStaking staking = new MasonryGenesisStaking(
            pass,
            lpFee,
            IMasonryGenesisSettlement(address(new LaunchSettlement(IERC20(address(pool.level))))),
            IERC20(USDG),
            10_000e18
        );
        lpFee.setGenesis(address(staking));
        pool.level.mint(address(this), 10_000e18);
        pool.level.approve(address(staking), 10_000e18);
        staking.fund();
        vm.warp(schedule.start());
        vm.startPrank(user);
        IERC20(USDG).approve(address(staking), 1000e6);
        staking.deposit(0, 1000e6);
        vm.stopPrank();
        (uint256 shares,,) = staking.positions(0, user);
        assertEq(shares, 1000e6);
    }

    function _tinyBuy(
        LivePool memory pool
    ) internal {
        IERC20(USDG).approve(address(pool.swaps), type(uint256).max);
        pool.swaps
            .swap(
                pool.key,
                SwapParams({
                    zeroForOne: !pool.level0,
                    amountSpecified: -int256(100e6),
                    sqrtPriceLimitX96: pool.level0 ? TickMath.MAX_SQRT_PRICE - 1 : TickMath.MIN_SQRT_PRICE + 1
                }),
                PoolSwapTest.TestSettings(false, false),
                ""
            );
    }

    function _sellLevel(
        LivePool memory pool,
        address user
    ) internal {
        _tinyBuy(pool);
        vm.warp(block.timestamp + 35 minutes);
        _tinyBuy(pool);
        pool.level.mint(user, 1000e18);
        uint256 userLevelBefore = pool.level.balanceOf(user);
        uint256 userUsdgBefore = IERC20(USDG).balanceOf(user);
        vm.startPrank(user);
        pool.level.approve(address(pool.swaps), type(uint256).max);
        pool.swaps
            .swap(
                pool.key,
                SwapParams({
                    zeroForOne: pool.level0,
                    amountSpecified: -int256(100e18),
                    sqrtPriceLimitX96: pool.level0 ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                PoolSwapTest.TestSettings(false, false),
                ""
            );
        vm.stopPrank();
        assertLt(pool.level.balanceOf(user), userLevelBefore, "sold xTOMB");
        assertGt(IERC20(USDG).balanceOf(user), userUsdgBefore, "received USDG");
    }

    struct ModernRuntime {
        MasonryTreasury treasury;
        MasonryFarm farm;
        MasonryBond bond;
        MasonryChamber chamber;
        uint256 start;
    }

    /// @dev Launches MasonryTreasury / Farm / X Bond. Does not construct the
    /// legacy Treasury, Boardroom, TrustNote or PegDefenseHook.
    function _wireModernRuntime(
        LaunchLevel level,
        MockTwapOracle twap,
        address user
    ) internal {
        ModernRuntime memory runtime = _deployModernRuntime(level, twap);
        _stakeRuntime(runtime, user);
        _exerciseExpansion(runtime, level, twap);
        _exerciseFarm(runtime, user);
        _exerciseBond(runtime, level, twap, user);
        _exerciseExitNow(runtime, level, user);
    }

    function _deployModernRuntime(
        LaunchLevel level,
        MockTwapOracle twap
    ) internal returns (ModernRuntime memory runtime) {
        MasonryLaunchParams memory cfg = MasonryLaunchConfig.load(vm);
        uint8 dec = level.decimals();
        uint256 farmBudget = MasonryLaunchConfig.scaleWhole(cfg.farmWholeTokens, dec);
        uint256 bondSupply = MasonryLaunchConfig.scaleWhole(cfg.bondMaxSupplyWholeTokens, dec);
        runtime.start = block.timestamp + 1 hours;
        LaunchShareWethLp slp = new LaunchShareWethLp();
        LaunchShare share = new LaunchShare();
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        runtime.chamber = new MasonryChamber(
            IERC20(address(slp)), IERC20(address(level)), predicted, address(0xA11CE), address(0xA2B)
        );
        runtime.treasury = new MasonryTreasury(
            IMasonryMintableLevel(address(level)),
            runtime.chamber,
            twap,
            runtime.start,
            uint16(cfg.expansionRateBps),
            cfg.oracleMaxAgeSeconds,
            address(this)
        );
        assertEq(address(runtime.treasury), predicted);
        runtime.farm = new MasonryFarm(
            IERC20(address(share)),
            runtime.start,
            cfg.farmEmissionDays * 1 days,
            farmBudget,
            address(this),
            IERC20(address(slp)),
            cfg.farmShareWethLpAllocPoints
        );
        runtime.bond = new MasonryBond(
            IERC20(address(level)),
            runtime.treasury,
            twap,
            uint16(cfg.bondMaxDiscountBps),
            uint16(cfg.bondMaxDebtRatioBps),
            bondSupply,
            uint16(cfg.bondRedeemPremiumBps),
            cfg.oracleMaxAgeSeconds
        );
        runtime.treasury.setBond(address(runtime.bond));
        share.mint(address(this), farmBudget);
        share.approve(address(runtime.farm), farmBudget);
        runtime.farm.fund(farmBudget);
    }

    function _stakeRuntime(
        ModernRuntime memory runtime,
        address user
    ) internal {
        IERC20 slp = runtime.chamber.stakeToken();
        // The deploy function minted 200 LP to this contract (see above) — remint if needed.
        if (slp.balanceOf(address(this)) < 200 ether) {
            LaunchShareWethLp(address(slp)).mint(address(this), 200 ether);
        }
        slp.transfer(user, 200 ether);
        vm.startPrank(user);
        slp.approve(address(runtime.chamber), type(uint256).max);
        runtime.chamber.stake(100 ether);
        slp.approve(address(runtime.farm), type(uint256).max);
        runtime.farm.deposit(0, 100 ether);
        vm.stopPrank();
    }

    function _exerciseExpansion(
        ModernRuntime memory runtime,
        LaunchLevel level,
        MockTwapOracle twap
    ) internal {
        twap.setPrice(1.02e18);
        vm.warp(runtime.start + 1);
        uint256 supply = level.totalSupply();
        runtime.treasury.allocateExpansion();
        assertGt(level.totalSupply(), supply, "expansion above peg");
        vm.warp(runtime.treasury.nextEpochPoint() + 1);
        twap.setPrice(1e18);
        supply = level.totalSupply();
        runtime.treasury.allocateExpansion();
        assertEq(level.totalSupply(), supply, "no mint at peg");
    }

    function _exerciseFarm(
        ModernRuntime memory runtime,
        address user
    ) internal {
        vm.warp(runtime.start + 2 days);
        vm.prank(user);
        runtime.farm.harvest(0);
        assertLe(runtime.farm.emitted(), runtime.farm.entitledTo(block.timestamp));
        assertLe(runtime.farm.claimed(), runtime.farm.rewardBudget());
    }

    function _exerciseBond(
        ModernRuntime memory runtime,
        LaunchLevel level,
        MockTwapOracle twap,
        address user
    ) internal {
        level.mint(user, 1000 ether);
        twap.setPrice(0.9e18);
        vm.startPrank(user);
        level.approve(address(runtime.bond), type(uint256).max);
        runtime.bond.buy(100 ether);
        uint256 bonds = runtime.bond.balanceOf(user);
        vm.stopPrank();
        assertGt(bonds, 100 ether);
        assertLe(runtime.bond.totalSupply() * 10_000, level.totalSupply() * runtime.bond.maxDebtRatioBps());
        twap.setPrice(1.05e18);
        vm.prank(user);
        runtime.bond.redeem(bonds);
        assertEq(runtime.bond.balanceOf(user), 0);
    }

    function _exerciseExitNow(
        ModernRuntime memory runtime,
        LaunchLevel level,
        address user
    ) internal {
        uint256 pending = runtime.chamber.pending(user);
        uint256 staked = runtime.chamber.balanceOf(user);
        uint256 userLevel = level.balanceOf(user);
        vm.prank(user);
        runtime.chamber.exitNow();
        assertEq(runtime.chamber.balanceOf(user), 0);
        assertEq(level.balanceOf(user), userLevel, "Exit Now is not a tax-free LEVEL exit");
        assertEq(level.balanceOf(address(0xA2B)), pending);
        assertEq(runtime.chamber.stakeToken().balanceOf(address(0xA11CE)), staked - staked / 2);
    }

    function _exerciseRangeManagers(
        LivePool memory pool
    ) internal {
        MasonryLaunchParams memory cfg = MasonryLaunchConfig.load(vm);
        assertEq(cfg.rangeHalfWidthBps, 1500);
        assertEq(cfg.rangeRecenterBps, 1000);
        assertEq(cfg.rangeCooldownSeconds, 1800);
        assertEq(cfg.rangeMaxTwapDeviationBps, 300);
        _exerciseLevelRange(pool);
        _exerciseShareRange();
    }

    function _exerciseLevelRange(
        LivePool memory pool
    ) internal {
        IPoolManager pm = IPoolManager(POOL_MANAGER);
        MockTwapOracle rangeTwap = new MockTwapOracle();
        (uint160 sqrtPrice,,,) = StateLibrary.getSlot0(pm, pool.key.toId());
        rangeTwap.setPrice(MasonryLevelPrice.fromSqrtPrice(sqrtPrice, pool.level0));
        MasonryRangeManager levelRm = new MasonryRangeManager(
            pm, pool.key, IMasonryRangeTwap(address(rangeTwap)), address(this), pool.level0, 1500, 1000, 1800, 300, 1e12
        );
        pool.level.mint(address(this), 50_000e18);
        deal(USDG, address(this), IERC20(USDG).balanceOf(address(this)) + 50_000e6);
        IERC20(address(pool.level)).approve(address(levelRm), type(uint256).max);
        IERC20(USDG).approve(address(levelRm), type(uint256).max);
        levelRm.donate(10_000e18, 10_000e6);
        assertTrue(levelRm.seeded());
        vm.expectRevert(MasonryRangeManager.NoRecenterNeeded.selector);
        levelRm.rebalance();
    }

    function _exerciseShareRange() internal {
        IPoolManager pm = IPoolManager(POOL_MANAGER);
        LaunchShare share = new LaunchShare();
        bool share0 = address(share) < USDG;
        PoolKey memory shareKey = PoolKey({
            currency0: Currency.wrap(share0 ? address(share) : USDG),
            currency1: Currency.wrap(share0 ? USDG : address(share)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0))
        });
        uint160 peg = uint160(share0 ? (uint256(1) << 96) / 1e6 : (uint256(1) << 96) * 1e6);
        pm.initialize(shareKey, peg);
        PoolModifyLiquidityTest liquidity = new PoolModifyLiquidityTest(pm);
        share.mint(address(this), 2_000_000e18);
        share.approve(address(liquidity), type(uint256).max);
        IERC20(USDG).approve(address(liquidity), type(uint256).max);
        int24 center = TickMath.getTickAtSqrtPrice(peg) / 60 * 60;
        liquidity.modifyLiquidity(shareKey, ModifyLiquidityParams(center - 6000, center + 6000, 1e16, 0), "");
        MockTwapOracle rangeTwap = new MockTwapOracle();
        rangeTwap.setPrice(1e18);
        MasonryRangeManager shareRm = new MasonryRangeManager(
            pm, shareKey, IMasonryRangeTwap(address(rangeTwap)), address(this), share0, 1500, 1000, 1800, 300, 1e12
        );
        share.approve(address(shareRm), type(uint256).max);
        IERC20(USDG).approve(address(shareRm), type(uint256).max);
        shareRm.donate(10_000e18, 10_000e6);
        assertTrue(shareRm.seeded());
        assertGt(shareRm.liquidity(), 0);
        vm.expectRevert(MasonryRangeManager.NoRecenterNeeded.selector);
        shareRm.rebalance();

        PoolSwapTest swaps = new PoolSwapTest(pm);
        share.mint(address(this), 1_000_000e18);
        share.approve(address(swaps), type(uint256).max);
        IERC20(USDG).approve(address(swaps), type(uint256).max);
        (, int24 tick,,) = StateLibrary.getSlot0(pm, shareKey.toId());
        int24 target = share0 ? tick - 1300 : tick + 1300;
        swaps.swap(
            shareKey,
            SwapParams({
                zeroForOne: share0,
                amountSpecified: -int256(1_000_000e18),
                sqrtPriceLimitX96: TickMath.getSqrtPriceAtTick(target)
            }),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        vm.expectRevert(MasonryRangeManager.UnsafeRebalance.selector);
        shareRm.rebalance();
        (uint160 sqrtAfter,,,) = StateLibrary.getSlot0(pm, shareKey.toId());
        rangeTwap.setPrice(MasonryLevelPrice.fromSqrtPrice(sqrtAfter, share0));
        int24 oldLower = shareRm.tickLower();
        shareRm.rebalance();
        assertTrue(shareRm.tickLower() != oldLower);
        assertFalse(shareRm.shouldRebalance());
    }
}
