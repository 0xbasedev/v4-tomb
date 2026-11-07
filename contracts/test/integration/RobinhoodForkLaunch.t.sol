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

contract LaunchLevel is ERC20Burnable {
    constructor() ERC20("X Tomb", "xTOMB") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract LaunchVault is ERC20, IMasonryRedeemableLPVault {
    IERC20 public immutable level;
    IERC20 public immutable usdc;
    PoolKey private key;
    constructor(IERC20 level_, IERC20 usdc_) ERC20("LP", "LP") {
        level = level_;
        usdc = usdc_;
    }
    function setPoolKey(PoolKey memory key_) external { key = key_; }
    function poolKey() external view returns (PoolKey memory) { return key; }
    function mintShares(address to, uint256 shares) external { _mint(to, shares); }
    function redeem(uint256 shares, address to) external returns (uint256 levelReceived, uint256 usdcReceived) {
        _burn(msg.sender, shares);
        levelReceived = shares / 2;
        usdcReceived = 0;
        level.transfer(to, levelReceived);
    }
}

contract LaunchGuard is IMasonryBuybackExecutionGuard {
    PoolId public officialPool;
    function setPoolKey(PoolKey memory key_) external { officialPool = PoolIdLibrary.toId(key_); }
    function minimumLevelOut(uint256) external pure returns (uint256) { return 1; }
}

contract LaunchRouter is IMasonryExactInputV4Router {
    function swapExactIn(PoolKey calldata, bool, uint256, uint256, address) external pure returns (uint256) {
        revert("dry-run router unused");
    }
}

contract LaunchSettlement is IMasonryGenesisSettlement {
    IERC20 private immutable level;
    constructor(IERC20 level_) { level = level_; }
    function settle(address beneficiary, uint256 reward, bool, bool, CompoundPlan calldata) external {
        if (reward > 0) level.transfer(beneficiary, reward);
    }
}

contract MockTwapOracle is IMasonryValidatedLevelTwap {
    uint256 public price = 1e18;
    function latestValidatedTwap() external view returns (uint256, uint256, bool) {
        return (price, block.timestamp, true);
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
    }

    function _launchOfficialPool(MasonryGenesisSchedule schedule) internal returns (LivePool memory pool) {
        pool.level = new LaunchLevel();
        pool.swaps = new PoolSwapTest(IPoolManager(POOL_MANAGER));
        pool.level0 = address(pool.level) < USDG;
        (address expected, bytes32 salt, MasonryTaxHook.OracleConfig memory oracleConfig) = _mineHook(schedule, pool.level);
        pool.key = PoolKey({
            currency0: Currency.wrap(pool.level0 ? address(pool.level) : USDG),
            currency1: Currency.wrap(pool.level0 ? USDG : address(pool.level)),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(expected)
        });
        assertEq(address(new MasonryLevelOracle(pool.key.toId(), pool.level0, 1e15, expected)), address(oracleConfig.oracle));
        assertEq(address(_deployHook(schedule, oracleConfig, address(pool.level), salt)), expected);
        _seedPool(pool);
    }

    function _mineHook(MasonryGenesisSchedule schedule, LaunchLevel level)
        internal view
        returns (address expected, bytes32 salt, MasonryTaxHook.OracleConfig memory oracleConfig)
    {
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
                abi.encode(IPoolManager(POOL_MANAGER), schedule, oracleConfig, level, USDG, address(0xA11CE), uint24(3000), int24(60))
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

    function _seedPool(LivePool memory pool) internal {
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

    function _buyUltra(MasonryGenesisPass pass, address user, address treasury) internal {
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
            pass, lpFee, IMasonryGenesisSettlement(address(new LaunchSettlement(IERC20(address(pool.level))))), IERC20(USDG), 10_000e18
        );
        lpFee.setGenesis(address(staking));
        pool.level.mint(address(this), 10_000e18);
        pool.level.approve(address(staking), 10_000e18);
        staking.fund();
        vm.warp(schedule.start());
        vm.startPrank(user);
        IERC20(USDG).approve(address(staking), 1_000e6);
        staking.deposit(0, 1_000e6);
        vm.stopPrank();
        (uint256 shares,,) = staking.positions(0, user);
        assertEq(shares, 1_000e6);
    }

    function _tinyBuy(LivePool memory pool) internal {
        IERC20(USDG).approve(address(pool.swaps), type(uint256).max);
        pool.swaps.swap(
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

    function _sellLevel(LivePool memory pool, address user) internal {
        _tinyBuy(pool);
        vm.warp(block.timestamp + 35 minutes);
        _tinyBuy(pool);
        pool.level.mint(user, 1_000e18);
        uint256 userLevelBefore = pool.level.balanceOf(user);
        uint256 userUsdgBefore = IERC20(USDG).balanceOf(user);
        vm.startPrank(user);
        pool.level.approve(address(pool.swaps), type(uint256).max);
        pool.swaps.swap(
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
}
