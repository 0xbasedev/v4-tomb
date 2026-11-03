// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @notice Public chain dependencies come from the shared manifest, never a chain-ID switch.
/// @dev Run from contracts/. An unconfigured profile intentionally cannot broadcast.
abstract contract NetworkConfig is Script {
    error WrongChain(uint256 configured, uint256 actual);
    error InvalidInfrastructure(string key, address value);
    error InvalidPegDecimals(uint8 decimals);
    error IncompatiblePositionManager();

    function _network() internal view virtual returns (string memory json, string memory path) {
        json = vm.readFile(vm.envOr("PROTOCOL_CONFIG", string("../config/networks.json")));
        require(vm.parseJsonUint(json, ".schemaVersion") == 1, "Config: schema version");
        path = string.concat(".networks[", vm.toString(_networkIndex()), "]");
        uint256 configured = vm.parseJsonUint(json, string.concat(path, ".id"));
        if (configured != block.chainid) revert WrongChain(configured, block.chainid);
    }

    function _networkIndex() internal view virtual returns (uint256) {
        return vm.envOr("PROTOCOL_NETWORK_INDEX", uint256(0));
    }

    function _infrastructure(
        string memory key
    ) internal view virtual returns (address value) {
        (string memory json, string memory path) = _network();
        value = vm.parseJsonAddress(json, string.concat(path, ".infrastructure.", key));
        if (value == address(0) || value.code.length == 0) revert InvalidInfrastructure(key, value);
    }

    function _deployment(
        string memory key
    ) internal view virtual returns (address value) {
        (string memory json, string memory path) = _network();
        value = vm.parseJsonAddress(json, string.concat(path, ".deployment.", key));
        require(value != address(0) && value.code.length > 0, "Config: invalid deployment address");
    }

    /// @dev The current price math is WETH-denominated and assumes 18 decimals.
    ///      Keep that protocol design explicit rather than silently accepting other pegs.
    function _preflight() internal view {
        uint8 decimals = IERC20Metadata(_infrastructure("weth")).decimals();
        if (decimals != 18) revert InvalidPegDecimals(decimals);
        address manager = _infrastructure("poolManager");
        address positions = _infrastructure("positionManager");
        address permit = _infrastructure("permit2");
        _infrastructure("create2Deployer");
        _infrastructure("universalRouter");
        (bool ok, bytes memory data) = positions.staticcall(abi.encodeWithSignature("poolManager()"));
        if (!ok || data.length != 32 || abi.decode(data, (address)) != manager) {
            revert IncompatiblePositionManager();
        }
        (ok, data) = positions.staticcall(abi.encodeWithSignature("permit2()"));
        if (!ok || data.length != 32 || abi.decode(data, (address)) != permit) {
            revert IncompatiblePositionManager();
        }
    }
}
