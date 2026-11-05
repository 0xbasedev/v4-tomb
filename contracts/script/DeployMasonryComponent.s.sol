// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Create3Config} from "./Create3Config.s.sol";

/// @notice Deploys one Masonry component from a reviewed plan. Initcode includes its constructor arguments.
contract DeployMasonryComponent is Create3Config {
    error WrongChain(uint256 expected, uint256 actual);
    error UnapprovedInitCode();

    function run(
        string calldata role,
        bytes calldata initCode
    ) external returns (address deployed) {
        string memory config = vm.readFile(vm.envString("MASONRY_CREATE3_CONFIG"));
        uint256 chainId = vm.parseJsonUint(config, ".chainId");
        if (chainId != block.chainid) revert WrongChain(chainId, block.chainid);
        Create3Plan memory plan = _readCreate3(config, "$");

        bytes32 approvedHash = vm.parseJsonBytes32(config, string.concat(".initCodeHashes.", role));
        if (initCode.length == 0 || keccak256(initCode) != approvedHash) revert UnapprovedInitCode();
        address expected = vm.parseJsonAddress(config, string.concat(".addresses.", role));
        uint256 nonce;
        bytes32 roleHash = keccak256(bytes(role));
        if (roleHash == keccak256("masonryTaxHook") || roleHash == keccak256("masonryShareTaxHook")) {
            nonce = vm.parseJsonUint(config, string.concat(".hookNonces.", role));
            if (uint160(expected) & 0x3fff != 0x35c8) revert InvalidCreate3Plan();
        } else {
            nonce = _addressNonce(config, "$", role);
        }
        vm.startBroadcast(plan.deployer);
        deployed = _deployCreate3(plan, role, nonce, expected, initCode);
        vm.stopBroadcast();
    }
}
