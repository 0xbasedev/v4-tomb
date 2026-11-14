// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {console2} from "forge-std/Script.sol";

import {Create3Config} from "./Create3Config.s.sol";
import {XTombShareBridge} from "../src/bridge/XTombShareBridge.sol";
import {XTombBridgedShare} from "../src/bridge/XTombBridgedShare.sol";
import {IHyperlaneMailbox} from "../src/bridge/IHyperlaneMailbox.sol";

/// @notice Deploys one preconfigured bridge and its satellite token without enabling sends.
contract DeployXTombShareBridge is Create3Config {
    struct Network {
        address bridge;
        address asset;
        address mailbox;
        address verifier;
        address owner;
        uint32 domain;
    }

    struct Predicted {
        address bridge;
        address homeToken;
        address satelliteToken;
    }

    error InvalidManifest();
    error WrongChain(uint256 expected, uint256 actual);
    error UnexpectedVerifier();

    function run(
        uint256 networkIndex
    ) external returns (XTombShareBridge bridge) {
        string memory path = vm.envOr("XSHARE_BRIDGE_CONFIG", string("../config/xshare-bridge.json"));
        string memory config = vm.readFile(path);
        if (vm.parseJsonUint(config, ".schemaVersion") != 1 || networkIndex >= 4) revert InvalidManifest();

        Create3Plan memory plan = _readCreate3(config, ".create3");
        uint32 canonical = _domain(vm.parseJsonUint(config, ".canonicalDomain"));
        Network memory local = _network(config, networkIndex);
        if (local.domain != block.chainid) revert WrongChain(local.domain, block.chainid);
        if (
            local.mailbox.code.length == 0 || local.verifier.code.length == 0
                || IHyperlaneMailbox(local.mailbox).localDomain() != local.domain
        ) revert InvalidManifest();

        XTombShareBridge.PeerConfig[] memory peers = _validateAndReadPeers(config, plan, local, canonical);
        if (local.bridge.code.length != 0 || vm.getNonce(local.bridge) != 0) {
            revert Create3AddressOccupied(local.bridge);
        }

        vm.startBroadcast(plan.deployer);
        if (local.domain != canonical) {
            if (local.asset.code.length == 0) {
                _deployCreate3(
                    plan,
                    "bridgedShare",
                    _addressNonce(config, ".create3", "bridgedShare"),
                    local.asset,
                    abi.encodePacked(type(XTombBridgedShare).creationCode, abi.encode(local.bridge))
                );
            }
            // A completed satellite token deployment can be reused if the bridge transaction is interrupted.
            if (XTombBridgedShare(local.asset).bridge() != local.bridge) revert InvalidManifest();
        }
        bridge = XTombShareBridge(
            _deployCreate3(
                plan,
                "xshareBridge",
                _addressNonce(config, ".create3", "xshareBridge"),
                local.bridge,
                abi.encodePacked(
                    type(XTombShareBridge).creationCode,
                    abi.encode(local.mailbox, local.verifier, canonical, local.asset, local.owner, peers)
                )
            )
        );
        vm.stopBroadcast();

        if (IHyperlaneMailbox(local.mailbox).recipientIsm(address(bridge)) != local.verifier) {
            revert UnexpectedVerifier();
        }
        console2.log("xSHARE bridge", address(bridge));
        console2.log("xSHARE asset", bridge.asset());
    }

    function _validateAndReadPeers(
        string memory config,
        Create3Plan memory plan,
        Network memory local,
        uint32 canonical
    ) private view returns (XTombShareBridge.PeerConfig[] memory peers) {
        bool isHome = local.domain == canonical;
        peers = new XTombShareBridge.PeerConfig[](isHome ? 3 : 1);
        Predicted memory predicted = _predict(config, plan);
        uint32[4] memory domains;
        uint256 count;
        for (uint256 i; i < 4; ++i) {
            Network memory remote = _network(config, i);
            for (uint256 j; j < i; ++j) {
                if (domains[j] == remote.domain) revert InvalidManifest();
            }
            domains[i] = remote.domain;
            bool remoteIsHome = remote.domain == canonical;
            if (
                remote.bridge != predicted.bridge
                    || remote.asset != (remoteIsHome ? predicted.homeToken : predicted.satelliteToken)
            ) {
                revert InvalidManifest();
            }
            if (remote.domain == local.domain || (!isHome && !remoteIsHome)) continue;
            uint256 cap = _routeCap(config, isHome ? remote.domain : local.domain);
            peers[count++] = XTombShareBridge.PeerConfig(remote.domain, remote.bridge, cap);
        }
        if (count != peers.length) revert InvalidManifest();
    }

    function _predict(
        string memory config,
        Create3Plan memory plan
    ) private view returns (Predicted memory) {
        string memory canonicalRole = vm.parseJsonString(config, ".canonicalTokenRole");
        bytes32 roleHash = keccak256(bytes(canonicalRole));
        if (roleHash != keccak256("estate") && roleHash != keccak256("masonryShare")) revert InvalidManifest();
        return Predicted(
            _create3Address(plan, "xshareBridge", _addressNonce(config, ".create3", "xshareBridge")),
            _create3Address(plan, canonicalRole, _addressNonce(config, ".create3", canonicalRole)),
            _create3Address(plan, "bridgedShare", _addressNonce(config, ".create3", "bridgedShare"))
        );
    }

    function _routeCap(
        string memory config,
        uint32 satellite
    ) private pure returns (uint256 cap) {
        string memory key = string.concat(".routeCaps['", vm.toString(satellite), "']");
        cap = vm.parseUint(vm.parseJsonString(config, key));
        if (cap == 0) revert InvalidManifest();
    }

    function _network(
        string memory config,
        uint256 index
    ) private pure returns (Network memory network) {
        string memory key = string.concat(".networks[", vm.toString(index), "]");
        network.domain = _domain(vm.parseJsonUint(config, string.concat(key, ".domain")));
        if (vm.parseJsonUint(config, string.concat(key, ".id")) != network.domain) revert InvalidManifest();
        network.bridge = vm.parseJsonAddress(config, string.concat(key, ".bridge"));
        network.asset = vm.parseJsonAddress(config, string.concat(key, ".token"));
        network.mailbox = vm.parseJsonAddress(config, string.concat(key, ".mailbox"));
        network.verifier = vm.parseJsonAddress(config, string.concat(key, ".bridgeIsm"));
        network.owner = vm.parseJsonAddress(config, string.concat(key, ".bridgeOwner"));
        if (network.owner == address(0) || network.verifier == address(0) || network.mailbox == address(0)) {
            revert InvalidManifest();
        }
    }

    function _domain(
        uint256 domain
    ) private pure returns (uint32) {
        if (domain != 8453 && domain != 56 && domain != 369 && domain != 146) {
            revert InvalidManifest();
        }
        return uint32(domain);
    }
}
