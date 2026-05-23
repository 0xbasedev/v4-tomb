// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {Addresses} from "../src/libs/Addresses.sol";
import {MiniSwapRouter} from "../src/swap/MiniSwapRouter.sol";

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";

/**
 * @title DeployMiniSwapRouter
 * @notice One-shot deploy of the in-house V4 swap router. Frontend uses this
 *         instead of Uniswap's UniversalRouter — see src/swap/MiniSwapRouter.sol
 *         for the rationale.
 *
 *         No env vars except DEPLOYER_PRIVATE_KEY. Address resolves from
 *         Addresses.poolManager() based on chain id.
 */
contract DeployMiniSwapRouter is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address pm = Addresses.poolManager();

        console2.log("=== DeployMiniSwapRouter ===");
        console2.log("chain id:    ", block.chainid);
        console2.log("poolManager: ", pm);

        vm.startBroadcast(pk);
        MiniSwapRouter router = new MiniSwapRouter(IPoolManager(pm));
        vm.stopBroadcast();

        console2.log("MiniSwapRouter:", address(router));
        console2.log("\nNext: add this address to frontend/src/lib/addresses.ts");
    }
}
