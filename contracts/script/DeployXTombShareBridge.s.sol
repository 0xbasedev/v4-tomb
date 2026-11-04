// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {XTombShareBridge} from "../src/bridge/XTombShareBridge.sol";
import {IHyperlaneMailbox} from "../src/bridge/IHyperlaneMailbox.sol";

/// @notice Deploys one bridge without enabling routes. Use the same manifest for all five deployments.
contract DeployXTombShareBridge is Script {
    error InvalidManifest();
    error WrongChain(uint256 expected, uint256 actual);
    error UnexpectedVerifier();

    function run(
        uint256 networkIndex,
        address owner,
        address canonicalToken
    ) external returns (XTombShareBridge bridge) {
        string memory path = vm.envOr("XSHARE_BRIDGE_CONFIG", string("../config/xshare-bridge.json"));
        string memory config = vm.readFile(path);
        if (vm.parseJsonUint(config, ".schemaVersion") != 1) revert InvalidManifest();

        uint256 canonical = vm.parseJsonUint(config, ".canonicalDomain");
        string memory network = string.concat(".networks[", vm.toString(networkIndex), "]");
        uint256 domain = vm.parseJsonUint(config, string.concat(network, ".domain"));
        uint256 chainId = vm.parseJsonUint(config, string.concat(network, ".id"));
        if (chainId != block.chainid) revert WrongChain(chainId, block.chainid);
        if (domain != chainId || canonical > type(uint32).max) revert InvalidManifest();

        address mailbox = vm.parseJsonAddress(config, string.concat(network, ".mailbox"));
        address ism = vm.parseJsonAddress(config, string.concat(network, ".bridgeIsm"));

        vm.startBroadcast();
        bridge = new XTombShareBridge(mailbox, ism, uint32(canonical), canonicalToken, owner);
        vm.stopBroadcast();

        if (IHyperlaneMailbox(mailbox).recipientIsm(address(bridge)) != ism) revert UnexpectedVerifier();
        console2.log("xSHARE bridge", address(bridge));
        console2.log("xSHARE asset", bridge.asset());
    }
}
