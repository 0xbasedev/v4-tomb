// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";

import {NetworkConfig} from "./NetworkConfig.s.sol";
import {Create3Config} from "./Create3Config.s.sol";
import {MiniSwapRouter} from "../src/swap/MiniSwapRouter.sol";

/**
 * @title DeployMiniSwapRouter
 * @notice One-shot deploy of the in-house V4 swap router. Frontend uses this
 *         instead of Uniswap's UniversalRouter — see src/swap/MiniSwapRouter.sol
 *         for the rationale.
 *
 *         Infrastructure resolves from the selected network manifest.
 */
contract DeployMiniSwapRouter is NetworkConfig, Create3Config {
    function run() external {
        (string memory json, string memory path) = _network();
        string memory planPath = string.concat(path, ".create3");
        Create3Plan memory plan = _readCreate3(json, planPath);
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        if (vm.addr(pk) != plan.deployer) revert InvalidCreate3Plan();
        address expected = vm.parseJsonAddress(json, string.concat(planPath, ".addresses.miniSwapRouter"));
        address pm = _infrastructure("poolManager");

        console2.log("=== DeployMiniSwapRouter ===");
        console2.log("chain id:    ", block.chainid);
        console2.log("poolManager: ", pm);

        vm.startBroadcast(pk);
        MiniSwapRouter router = MiniSwapRouter(
            payable(_deployCreate3(
                    plan,
                    "miniSwapRouter",
                    0,
                    expected,
                    abi.encodePacked(type(MiniSwapRouter).creationCode, abi.encode(pm))
                ))
        );
        vm.stopBroadcast();

        console2.log("MiniSwapRouter:", address(router));
        console2.log("\nNext: review this replacement router address in the deployment manifest");
    }
}
