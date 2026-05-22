// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {OldMoney} from "../src/tokens/OldMoney.sol";
import {Estate} from "../src/tokens/Estate.sol";
import {TrustNote} from "../src/tokens/TrustNote.sol";
import {Treasury} from "../src/core/Treasury.sol";
import {Boardroom} from "../src/core/Boardroom.sol";
import {Oracle} from "../src/oracle/Oracle.sol";
import {PegDefenseHook} from "../src/hooks/PegDefenseHook.sol";
import {Addresses} from "../src/libs/Addresses.sol";
import {ITreasury} from "../src/interfaces/ITreasury.sol";
import {IPriceSource} from "../src/interfaces/IPriceSource.sol";

import {GenesisRewardPool} from "../src/distribution/GenesisRewardPool.sol";
import {MainRewardPool} from "../src/distribution/MainRewardPool.sol";
import {ShareRewardPool} from "../src/distribution/ShareRewardPool.sol";

import {MockCbeth} from "./MockCbeth.sol";

import {HookMiner} from "../test/utils/HookMiner.sol";

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title Deploy
 * @notice One-shot Foundry deploy script for the Old Money protocol.
 *
 *         The script deploys the three reward pool contracts itself (GenesisRewardPool,
 *         MainRewardPool, ShareRewardPool) so the only remaining env-var addresses are
 *         the human-controlled ones: AIRDROP_WALLET, COMMUNITY_FUND, DEV_FUND.
 *
 *         See docs/DEPLOY.md for env-var setup and per-chain commands.
 */
contract Deploy is Script {
    using PoolIdLibrary for PoolKey;

    /// @notice Canonical deterministic CREATE2 deployer. When `vm.startBroadcast` is
    ///         active, Foundry routes `create2` calls (including the `new Contract{salt:}`
    ///         syntax and inline-assembly create2) through this address. So when mining a
    ///         hook address, we MUST mine against this deployer, not the EOA.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    struct Genesis {
        address airdropWallet;
        address communityFund;
        address devFund;
        uint256 vestingStart;
        uint256 epochStart;
    }

    OldMoney public money;
    Estate public estate;
    TrustNote public trustnote;
    PegDefenseHook public hook;
    Oracle public oracle;
    Treasury public treasury;
    Boardroom public boardroom;
    GenesisRewardPool public genesisRewardPool;
    MainRewardPool public mainRewardPool;
    ShareRewardPool public shareRewardPool;
    address public cbethAddress;
    PoolKey public poolKey;

    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        Genesis memory g = _readGenesis();

        console2.log("=== Old Money deploy ===");
        console2.log("chain id:", block.chainid);
        console2.log("deployer:", deployer);

        vm.startBroadcast(pk);

        cbethAddress = _resolveCbeth();
        _deployTokens(g);
        _deployHookAndInitPool(deployer);
        _deployOracle(g);
        _deployRewardPools(g);
        _deployCoreAndInit(g);

        // Genesis distributions go directly to the freshly deployed pool contracts.
        money.distributeReward(address(genesisRewardPool), address(mainRewardPool), g.airdropWallet);
        estate.distributeReward(address(shareRewardPool));

        money.transferTrustees(address(treasury));
        estate.transferTrustees(address(treasury));
        trustnote.transferTrustees(address(treasury));
        boardroom.setOperator(address(treasury));

        vm.stopBroadcast();

        _postDeployChecks(g);
    }

    // ------------------------------------------------------------------
    // Steps
    // ------------------------------------------------------------------

    function _readGenesis() internal view returns (Genesis memory g) {
        g.airdropWallet = vm.envAddress("AIRDROP_WALLET");
        g.communityFund = vm.envAddress("COMMUNITY_FUND");
        g.devFund = vm.envAddress("DEV_FUND");
        g.vestingStart = vm.envOr("VESTING_START", block.timestamp + 1 hours);
        g.epochStart = vm.envOr("EPOCH_START", g.vestingStart);
    }

    function _resolveCbeth() internal returns (address) {
        if (Addresses.hasCbeth()) {
            address real = Addresses.cbeth();
            console2.log("cbETH (real):", real);
            return real;
        }
        MockCbeth mock = new MockCbeth();
        console2.log("cbETH (mock):", address(mock));
        return address(mock);
    }

    function _deployTokens(
        Genesis memory g
    ) internal {
        money = new OldMoney();
        estate = new Estate(g.vestingStart, g.communityFund, g.devFund);
        trustnote = new TrustNote();
        console2.log("$MONEY:    ", address(money));
        console2.log("$ESTATE:   ", address(estate));
        console2.log("$TRUSTNOTE:", address(trustnote));
    }

    function _deployHookAndInitPool(
        address deployer
    ) internal {
        IPoolManager pm = IPoolManager(Addresses.poolManager());
        bytes memory creationCode = abi.encodePacked(type(PegDefenseHook).creationCode, abi.encode(pm, address(money)));
        uint160 flags = uint160(Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG);
        // Mine against the canonical CREATE2 deployer — Foundry routes broadcast
        // create2 calls through it, so the deployed address is derived from this
        // address, not the deployer EOA. (deployer param kept for ABI compat.)
        deployer; // silence unused-var warning
        (address mined, bytes32 salt) = HookMiner.find(CREATE2_DEPLOYER, flags, creationCode);

        PegDefenseHook deployedHook = new PegDefenseHook{salt: salt}(pm, address(money));
        require(address(deployedHook) == mined, "Deploy: hook addr mismatch");
        hook = deployedHook;
        console2.log("PegDefenseHook:", address(hook));

        (Currency c0, Currency c1) = address(money) < cbethAddress
            ? (Currency.wrap(address(money)), Currency.wrap(cbethAddress))
            : (Currency.wrap(cbethAddress), Currency.wrap(address(money)));
        poolKey = PoolKey({
            currency0: c0,
            currency1: c1,
            fee: LPFeeLibrary.DYNAMIC_FEE_FLAG,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
        pm.initialize(poolKey, TickMath.getSqrtPriceAtTick(0));
    }

    function _deployOracle(
        Genesis memory g
    ) internal {
        oracle = new Oracle(IPriceSource(address(hook)), address(money), cbethAddress, 6 hours, g.epochStart);
        console2.log("Oracle:", address(oracle));
    }

    /// @notice Deploy the three reward pools. Each constructor requires
    ///         block.timestamp < _poolStartTime, so:
    ///           - GenesisRewardPool opens at epochStart (24h window).
    ///           - MainRewardPool opens at epochStart + 1 day (genesis closes first).
    ///           - ShareRewardPool opens at epochStart + 1 day (concurrent with main).
    function _deployRewardPools(
        Genesis memory g
    ) internal {
        genesisRewardPool = new GenesisRewardPool(address(money), g.epochStart);
        mainRewardPool = new MainRewardPool(address(money), g.epochStart + 1 days);
        shareRewardPool = new ShareRewardPool(address(estate), g.epochStart + 1 days);
        console2.log("GenesisRewardPool:", address(genesisRewardPool));
        console2.log("MainRewardPool:   ", address(mainRewardPool));
        console2.log("ShareRewardPool:  ", address(shareRewardPool));
    }

    function _deployCoreAndInit(
        Genesis memory g
    ) internal {
        treasury = new Treasury();
        boardroom = new Boardroom();
        boardroom.initialize(IERC20(address(money)), IERC20(address(estate)), ITreasury(address(treasury)));

        // Pools + airdrop wallet are the addresses that hold un-emitted MONEY; they
        // must be excluded from `getMoneyCirculatingSupply` so the contraction-headroom
        // math doesn't count them as circulating.
        address[] memory excluded = new address[](3);
        excluded[0] = address(genesisRewardPool);
        excluded[1] = address(mainRewardPool);
        excluded[2] = g.airdropWallet;
        treasury.initialize(
            address(money),
            address(trustnote),
            address(estate),
            address(oracle),
            address(boardroom),
            g.epochStart,
            excluded
        );
        console2.log("Treasury: ", address(treasury));
        console2.log("Boardroom:", address(boardroom));
    }

    function _postDeployChecks(
        Genesis memory g
    ) internal view {
        require(money.operator() == address(treasury), "Deploy: money operator");
        require(estate.operator() == address(treasury), "Deploy: estate operator");
        require(trustnote.operator() == address(treasury), "Deploy: trustnote operator");
        require(boardroom.operator() == address(treasury), "Deploy: boardroom operator");
        require(hook.bound(), "Deploy: hook not bound");
        require(treasury.isInitialized(), "Deploy: treasury not initialized");

        require(money.balanceOf(address(genesisRewardPool)) == 11_000 ether, "Deploy: genesis funding mismatch");
        require(money.balanceOf(address(mainRewardPool)) == 140_000 ether, "Deploy: main funding mismatch");
        // Airdrop wallet may already hold MONEY (e.g., the 1-unit constructor seed if the
        // wallet happens to equal the deployer in a dry-run). Assert at least the 9k landed.
        require(money.balanceOf(g.airdropWallet) >= 9000 ether, "Deploy: airdrop funding mismatch");
        require(estate.balanceOf(address(shareRewardPool)) == 59_500 ether, "Deploy: share funding mismatch");

        console2.log("\n=== POST-DEPLOY SANITY ===");
        console2.log("GenesisRewardPool MONEY:", money.balanceOf(address(genesisRewardPool)));
        console2.log("MainRewardPool MONEY:   ", money.balanceOf(address(mainRewardPool)));
        console2.log("airdropWallet MONEY:    ", money.balanceOf(g.airdropWallet));
        console2.log("ShareRewardPool ESTATE: ", estate.balanceOf(address(shareRewardPool)));
        console2.log("\nNext: operator (deployer) calls .add(allocPoint, lpToken, false, 0) on each");
        console2.log("reward pool for each LP token pair to support (e.g. MONEY/cbETH, USDC/cbETH).");
    }
}
