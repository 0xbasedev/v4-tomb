// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
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

import {PegToken} from "../src/tokens/PegToken.sol";
import {ShareToken, ShareTokenProfiles} from "../src/tokens/ShareToken.sol";
import {MasonryTaxHook} from "../src/hooks/MasonryTaxHook.sol";
import {MasonryLevelHook} from "../src/hooks/MasonryLevelHook.sol";
import {MasonrySquareHook} from "../src/hooks/MasonrySquareHook.sol";
import {MasonryLevelOracle} from "../src/masonry/MasonryLevelOracle.sol";
import {MasonryGenesisSchedule} from "../src/masonry/MasonryGenesisSchedule.sol";
import {MasonryLevelUsdcVault} from "../src/masonry/MasonryLevelUsdcVault.sol";
import {MasonrySquareUsdcVault} from "../src/masonry/MasonrySquareUsdcVault.sol";
import {MasonryBuybackGuard} from "../src/masonry/MasonryBuybackGuard.sol";
import {MasonryCriticalDefense} from "../src/masonry/MasonryCriticalDefense.sol";
import {MasonryGenesisPass} from "../src/masonry/MasonryGenesisPass.sol";
import {MasonryGenesisSettlement} from "../src/masonry/MasonryGenesisSettlement.sol";
import {MasonryGenesisStaking} from "../src/masonry/MasonryGenesisStaking.sol";
import {
    MasonryGenesisLPBurnFee,
    IMasonryBurnableLevel,
    IMasonryExactInputV4Router
} from "../src/masonry/MasonryGenesisLPBurnFee.sol";
import {MiniSwapRouter} from "../src/swap/MiniSwapRouter.sol";
import {HookMiner} from "../test/utils/HookMiner.sol";

/// @notice Six-decimal USDC with open minting — local rehearsals only.
contract LocalUSDC is ERC20 {
    constructor() ERC20("USD Coin (local)", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

/**
 * @title DeployMasonryLocal
 * @notice One-shot Masonry (xTOMB / xSHARE) launch on a local anvil chain, for UI and wallet
 *         rehearsal. Uses the real token, hook, oracle, vault, Genesis and routing contracts in
 *         the order proven by test/integration/MasonryLevelHook.t.sol; only USDC and the v4
 *         PoolManager are local stand-ins.
 *
 *         Leaves Genesis UNSCHEDULED (start = 0) with staking funded and settlement bound, so
 *         Admin's one-time schedule() is the next step — exactly the production sequence.
 *
 *         NOT a production deploy: no CREATE3 (addresses are plain CREATE / CREATE2 for hooks),
 *         seed liquidity and oracle bounds are rehearsal values, and every role is the deployer.
 *
 *   anvil &
 *   forge script script/DeployMasonryLocal.s.sol --rpc-url http://127.0.0.1:8545 \
 *     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast
 *
 *   Writes deployment-output/masonry-local.json in the config/masonry-deployments.json shape.
 */
contract DeployMasonryLocal is Script {
    using PoolIdLibrary for PoolKey;

    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint24 internal constant FEE = 3000;
    int24 internal constant SPACING = 60;
    uint160 internal constant HOOK_FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG
        | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
        | Hooks.AFTER_ADD_LIQUIDITY_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_FLAG;

    /// Rehearsal economics (template values where the template has them).
    uint256 internal constant GENESIS_REWARD_BUDGET = 1_050_000 ether; // not in the template — owner decision
    uint256 internal constant SEED_LIQUIDITY = 1e16;
    uint256 internal constant SQUARE_REFERENCE_PRICE = 120e18;

    struct Deployed {
        address deployer;
        address treasury;
        LocalUSDC usdc;
        PoolManager manager;
        PoolModifyLiquidityTest liquidity;
        PegToken level;
        ShareToken square;
        MasonryGenesisSchedule schedule;
        MasonryLevelHook levelHook;
        PoolKey levelKey;
        MasonryLevelUsdcVault levelVault;
        MasonryBuybackGuard guard;
        MiniSwapRouter router;
        MasonryGenesisLPBurnFee lpBurnFee;
        MasonryGenesisPass pass;
        MasonryGenesisSettlement settlement;
        MasonryGenesisStaking staking;
        MasonryCriticalDefense defense;
        MasonrySquareHook squareHook;
        PoolKey squareKey;
        MasonrySquareUsdcVault squareVault;
    }

    function run() external returns (Deployed memory d) {
        vm.startBroadcast();
        (, d.deployer,) = vm.readCallers();
        d.treasury = vm.envOr("TREASURY", d.deployer);

        d.usdc = new LocalUSDC();
        d.manager = new PoolManager(d.deployer);
        d.liquidity = new PoolModifyLiquidityTest(d.manager);

        // xTOMB: PegToken unchanged; its legacy distributeReward is never called.
        d.level = new PegToken(d.deployer);
        // xSHARE: the Masonry profile. Vesting buckets are unset in the template, so the
        // remainder sits with the deployer here; farming (25,641) mints to the Farm later.
        d.square = new ShareToken(ShareTokenProfiles.masonry(_shareAllocations(d), 25_641 ether, 33_333 ether), d.deployer);

        // Genesis clock deployed unscheduled; the deployer is the scheduler.
        d.schedule = new MasonryGenesisSchedule(0, d.deployer);

        _levelPool(d);
        _genesis(d);
        _squarePool(d);
        vm.stopBroadcast();

        _write(d);
    }

    function _shareAllocations(
        Deployed memory d
    ) internal pure returns (ShareToken.Allocation[] memory a) {
        a = new ShareToken.Allocation[](4);
        a[0] = ShareToken.Allocation(d.deployer, 100 ether + 1 ether + 6941 ether); // sale escrow + deployer + vesting (local)
        a[1] = ShareToken.Allocation(d.deployer, 100 ether); // owner / team / developer
        a[2] = ShareToken.Allocation(d.treasury, 500 ether);
        a[3] = ShareToken.Allocation(d.deployer, 50 ether); // arbitrage
    }

    function _key(
        address asset,
        address usdc,
        address hook
    ) internal pure returns (PoolKey memory) {
        bool asset0 = asset < usdc;
        return PoolKey(
            Currency.wrap(asset0 ? asset : usdc), Currency.wrap(asset0 ? usdc : asset), FEE, SPACING, IHooks(hook)
        );
    }

    /// $1 for an 18-decimal asset against 6-decimal USDC.
    function _peg(
        bool asset0
    ) internal pure returns (uint160) {
        return uint160(asset0 ? (uint256(1) << 96) / 1e6 : (uint256(1) << 96) * 1e6);
    }

    function _levelPool(
        Deployed memory d
    ) internal {
        // The hook's oracle is created right after the hook address is known; predict it.
        address oracle = vm.computeCreateAddress(d.deployer, vm.getNonce(d.deployer));
        MasonryTaxHook.OracleConfig memory oc = MasonryTaxHook.OracleConfig(MasonryLevelOracle(oracle), d.deployer);
        bytes memory code = bytes.concat(
            type(MasonryLevelHook).creationCode,
            abi.encode(d.manager, d.schedule, oc, d.level, d.usdc, d.treasury, FEE, SPACING)
        );
        (address hookAddress, bytes32 salt) = HookMiner.find(CREATE2_DEPLOYER, HOOK_FLAGS, code);
        d.levelKey = _key(address(d.level), address(d.usdc), hookAddress);
        new MasonryLevelOracle(d.levelKey.toId(), address(d.level) < address(d.usdc), 1e15, hookAddress);
        d.levelHook = new MasonryLevelHook{salt: salt}(
            d.manager, d.schedule, oc, address(d.level), address(d.usdc), d.treasury, FEE, SPACING
        );
        require(address(d.levelHook) == hookAddress, "level hook address");

        bool level0 = address(d.level) < address(d.usdc);
        uint160 peg = _peg(level0);
        d.manager.initialize(d.levelKey, peg);
        int24 center = TickMath.getTickAtSqrtPrice(peg) / SPACING * SPACING;
        _seed(d, d.levelKey, center);
        d.levelVault = new MasonryLevelUsdcVault(d.levelKey, center - 6000, center + 6000);
    }

    function _seed(
        Deployed memory d,
        PoolKey memory key,
        int24 center
    ) internal {
        d.level.mint(d.deployer, 1_000_000 ether);
        d.usdc.mint(d.deployer, 10_000_000e6);
        d.level.approve(address(d.liquidity), type(uint256).max);
        d.square.approve(address(d.liquidity), type(uint256).max);
        d.usdc.approve(address(d.liquidity), type(uint256).max);
        d.liquidity.modifyLiquidity(key, ModifyLiquidityParams(center - 6000, center + 6000, int256(SEED_LIQUIDITY), 0), "");
    }

    function _genesis(
        Deployed memory d
    ) internal {
        d.guard = new MasonryBuybackGuard(d.levelKey, 150, 100, 150);
        d.router = new MiniSwapRouter(d.manager);
        d.lpBurnFee = new MasonryGenesisLPBurnFee(
            d.levelVault,
            IMasonryBurnableLevel(address(d.level)),
            d.usdc,
            IMasonryExactInputV4Router(address(d.router)),
            d.guard,
            d.levelKey,
            d.deployer,
            1e21,
            1e9,
            d.deployer
        );
        d.pass = new MasonryGenesisPass(d.usdc, d.treasury, d.schedule);
        d.settlement = new MasonryGenesisSettlement(d.levelVault, d.guard, d.router, d.treasury, d.deployer);
        d.staking = new MasonryGenesisStaking(d.pass, d.lpBurnFee, d.settlement, d.usdc, GENESIS_REWARD_BUDGET);
        // Wiring + funding — the readiness Admin checks before schedule().
        d.lpBurnFee.setGenesis(address(d.staking));
        d.settlement.bind(d.staking);
        d.level.mint(d.deployer, GENESIS_REWARD_BUDGET);
        d.level.approve(address(d.staking), GENESIS_REWARD_BUDGET);
        d.staking.fund();
    }

    function _squarePool(
        Deployed memory d
    ) internal {
        d.defense = new MasonryCriticalDefense(d.levelHook.oracle());
        MasonrySquareHook.RoutingConfig memory rc = MasonrySquareHook.RoutingConfig(
            d.levelKey, d.treasury, d.deployer, SQUARE_REFERENCE_PRICE, 100 ether, 300, d.defense
        );
        address oracle = vm.computeCreateAddress(d.deployer, vm.getNonce(d.deployer));
        MasonryTaxHook.OracleConfig memory oc = MasonryTaxHook.OracleConfig(MasonryLevelOracle(oracle), d.deployer);
        bytes memory code = bytes.concat(
            type(MasonrySquareHook).creationCode, abi.encode(d.manager, oc, d.square, d.usdc, FEE, SPACING, rc)
        );
        (address hookAddress, bytes32 salt) = HookMiner.find(CREATE2_DEPLOYER, HOOK_FLAGS, code);
        d.squareKey = _key(address(d.square), address(d.usdc), hookAddress);
        new MasonryLevelOracle(d.squareKey.toId(), address(d.square) < address(d.usdc), 1e15, hookAddress);
        d.squareHook = new MasonrySquareHook{salt: salt}(d.manager, oc, address(d.square), address(d.usdc), FEE, SPACING, rc);
        require(address(d.squareHook) == hookAddress, "square hook address");

        bool square0 = address(d.square) < address(d.usdc);
        // xSHARE seeds at its $120 reference: 120 USDC per 1e18 xSHARE.
        // Raw price is token1 per token0 in base units: 120e6 USDC units per 1e18 xSHARE units.
        uint160 price = uint160(square0 ? _sqrt(120e6 * (uint256(1) << 192) / 1e18) : _sqrt(1e18 * (uint256(1) << 192) / 120e6));
        d.manager.initialize(d.squareKey, price);
        int24 mid = TickMath.getTickAtSqrtPrice(price) / SPACING * SPACING;
        d.liquidity.modifyLiquidity(d.squareKey, ModifyLiquidityParams(mid - 6000, mid + 6000, int256(SEED_LIQUIDITY / 100), 0), "");
        d.squareVault = new MasonrySquareUsdcVault(d.squareKey, mid - 6000, mid + 6000);
        d.squareHook.bindPolVault(d.squareVault);
    }

    function _sqrt(
        uint256 x
    ) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }

    function _write(
        Deployed memory d
    ) internal {
        string memory contracts = string.concat(
            "{",
            _kv("level", address(d.level)), ",", _kv("square", address(d.square)), ",", _kv("usdc", address(d.usdc)), ",",
            _kv("poolManager", address(d.manager)), ",", _kv("treasury", d.treasury), ",", _kv("schedule", address(d.schedule)), ","
        );
        contracts = string.concat(
            contracts,
            _kv("pass", address(d.pass)), ",", _kv("staking", address(d.staking)), ",", _kv("settlement", address(d.settlement)), ",",
            _kv("lpBurnFee", address(d.lpBurnFee)), ",", _kv("levelHook", address(d.levelHook)), ",",
            _kv("levelOracle", address(d.levelHook.oracle())), ","
        );
        contracts = string.concat(
            contracts,
            _kv("buybackGuard", address(d.guard)), ",", _kv("levelVault", address(d.levelVault)), ",",
            _kv("squareHook", address(d.squareHook)), ",", _kv("squareVault", address(d.squareVault)), ",",
            _kv("criticalDefense", address(d.defense)), ",", _kv("miniSwapRouter", address(d.router)), "}"
        );
        string memory json = string.concat(
            '{"chainId":', vm.toString(block.chainid), ',"deployBlock":"', vm.toString(block.number), '","contracts":', contracts,
            ',"pools":{"level":', _keyJson(d.levelKey), ',"square":', _keyJson(d.squareKey), "}}"
        );
        vm.writeFile("./deployment-output/masonry-local.json", json);
        console2.log("Masonry local deployment written to deployment-output/masonry-local.json");
    }

    function _kv(
        string memory k,
        address v
    ) internal pure returns (string memory) {
        return string.concat('"', k, '":"', vm.toString(v), '"');
    }

    function _keyJson(
        PoolKey memory k
    ) internal pure returns (string memory) {
        return string.concat(
            '{"currency0":"', vm.toString(Currency.unwrap(k.currency0)), '","currency1":"', vm.toString(Currency.unwrap(k.currency1)),
            '","fee":', vm.toString(uint256(k.fee)), ',"tickSpacing":', vm.toString(int256(k.tickSpacing)), ',"hooks":"',
            vm.toString(address(k.hooks)), '"}'
        );
    }
}
