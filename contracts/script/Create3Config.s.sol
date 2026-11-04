// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";

interface ICreateX {
    function deployCreate3(
        bytes32 salt,
        bytes calldata initCode
    ) external payable returns (address);
    function computeCreate3Address(
        bytes32 guardedSalt
    ) external view returns (address);
}

/// @dev Use sender-protected salts and the official CreateX runtime on every chain.
abstract contract Create3Config is Script {
    address internal constant CREATEX = 0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed;
    bytes32 internal constant CREATEX_CODE_HASH = 0xbd8a7ea8cfca7b4e5f5041d7d4b17bc317c5ce42cfbc42066a00cf26b43eb53f;
    bytes32 private constant CREATE3_PROXY_HASH = 0x21c35dbe1b344a2488cf3321d6ce542f8e9f305544ff09e4993a62319a497c1f;

    struct Create3Plan {
        address factory;
        address deployer;
        bytes32 releaseId;
    }

    error InvalidCreate3Plan();
    error UnexpectedCreate3Address(string role, address expected, address actual);
    error Create3AddressOccupied(address predicted);

    function _readCreate3(
        string memory json,
        string memory path
    ) internal view returns (Create3Plan memory plan) {
        plan.factory = vm.parseJsonAddress(json, string.concat(path, ".factory"));
        plan.deployer = vm.parseJsonAddress(json, string.concat(path, ".deployer"));
        plan.releaseId = vm.parseJsonBytes32(json, string.concat(path, ".releaseId"));
        if (
            plan.factory != CREATEX || plan.factory.codehash != _createXCodeHash() || plan.deployer == address(0)
                || plan.releaseId == bytes32(0)
        ) revert InvalidCreate3Plan();
    }

    function _createXCodeHash() internal pure virtual returns (bytes32) {
        return CREATEX_CODE_HASH;
    }

    function _create3Salt(
        Create3Plan memory plan,
        string memory role,
        uint256 nonce
    ) internal pure returns (bytes32) {
        bytes11 namespace = bytes11(keccak256(abi.encodePacked(plan.releaseId, role, nonce)));
        // Flag zero permits the same protected address across the configured chains.
        return bytes32(abi.encodePacked(plan.deployer, bytes1(0), namespace));
    }

    function _create3Address(
        Create3Plan memory plan,
        string memory role,
        uint256 nonce
    ) internal pure returns (address) {
        bytes32 guarded = keccak256(abi.encode(plan.deployer, _create3Salt(plan, role, nonce)));
        address proxy = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), plan.factory, guarded, CREATE3_PROXY_HASH))))
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(hex"d694", proxy, hex"01")))));
    }

    function _deployCreate3(
        Create3Plan memory plan,
        string memory role,
        uint256 nonce,
        address expected,
        bytes memory initcode
    ) internal returns (address deployed) {
        address predicted = _create3Address(plan, role, nonce);
        if (predicted != expected) revert UnexpectedCreate3Address(role, expected, predicted);
        if (predicted.code.length != 0 || vm.getNonce(predicted) != 0) revert Create3AddressOccupied(predicted);

        bytes32 rawSalt = _create3Salt(plan, role, nonce);
        ICreateX factory = ICreateX(plan.factory);
        address factoryPrediction = factory.computeCreate3Address(keccak256(abi.encode(plan.deployer, rawSalt)));
        if (factoryPrediction != expected) revert UnexpectedCreate3Address(role, expected, factoryPrediction);
        deployed = factory.deployCreate3(rawSalt, initcode);
        if (deployed != expected || deployed.code.length == 0) {
            revert UnexpectedCreate3Address(role, expected, deployed);
        }
    }
}
