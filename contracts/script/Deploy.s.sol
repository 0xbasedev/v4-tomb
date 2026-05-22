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
 *         See docs/DEPLOY.md for env-var setup and per-chain commands.
 */
contract Deploy is Script {
    using PoolIdLibrary for PoolKey;

    struct Genesis {
        address genesisPool;
        address mainPool;
        address airdropWallet;
        address farmingPool;
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
        _deployCoreAndInit(g);

        money.distributeReward(g.genesisPool, g.mainPool, g.airdropWallet);
        estate.distributeReward(g.farmingPool);

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
        g.genesisPool = vm.envAddress("GENESIS_POOL");
        g.mainPool = vm.envAddress("MAIN_POOL");
        g.airdropWallet = vm.envAddress("AIRDROP_WALLET");
        g.farmingPool = vm.envAddress("FARMING_POOL");
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
        (address mined, bytes32 salt) = HookMiner.find(deployer, flags, creationCode);

        PegDefenseHook deployedHook;
        bytes memory codeLocal = creationCode;
        bytes32 saltLocal = salt;
        assembly {
            deployedHook := create2(0, add(codeLocal, 0x20), mload(codeLocal), saltLocal)
        }
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

    function _deployCoreAndInit(
        Genesis memory g
    ) internal {
        treasury = new Treasury();
        boardroom = new Boardroom();
        boardroom.initialize(IERC20(address(money)), IERC20(address(estate)), ITreasury(address(treasury)));

        address[] memory excluded = new address[](3);
        excluded[0] = g.genesisPool;
        excluded[1] = g.mainPool;
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

        console2.log("\n=== POST-DEPLOY SANITY ===");
        console2.log("genesisPool MONEY:  ", money.balanceOf(g.genesisPool));
        console2.log("mainPool MONEY:     ", money.balanceOf(g.mainPool));
        console2.log("airdropWallet MONEY:", money.balanceOf(g.airdropWallet));
        console2.log("farmingPool ESTATE: ", estate.balanceOf(g.farmingPool));
    }
}
