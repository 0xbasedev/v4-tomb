// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {GenesisRewardPool} from "../src/distribution/GenesisRewardPool.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title OpenGenesis
 * @notice Registers stake tokens on the GenesisRewardPool so users can deposit during the
 *         24-hour Genesis window. Must run BEFORE `poolStartTime` — emission ticks
 *         regardless of whether PIDs exist, and unregistered emission is lost.
 *
 *         The operator role on GenesisRewardPool is the deployer at construction (per
 *         Deploy.s.sol). After Sprint 14 governance rotation, this script must be
 *         re-targeted to the Timelock via queue/execute.
 *
 *         Required env vars:
 *           DEPLOYER_PRIVATE_KEY    — operator signer
 *           GENESIS_REWARD_POOL     — deployed pool address
 *           GENESIS_STAKE_TOKENS    — comma-separated list of ERC-20 token addresses
 *           GENESIS_ALLOC_POINTS    — comma-separated weights (parallel to stake tokens)
 *
 *         Example:
 *           export GENESIS_REWARD_POOL=0xBf5118...
 *           export GENESIS_STAKE_TOKENS="0x4200000000000000000000000000000000000006,0x036CbD53842c5426634e7929541eC2318f3dCF7e"
 *           export GENESIS_ALLOC_POINTS="100,100"
 *           forge script script/OpenGenesis.s.sol --rpc-url base_sepolia --broadcast
 *
 *         Per-token effect: `pool.add(allocPoint, token, false, 0)`.
 *         - `_withUpdate=false` because no prior PIDs need their accumulators bumped.
 *         - `_lastRewardTime=0` so the pool defaults to `poolStartTime` (Tomb pattern).
 */
contract OpenGenesis is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address pool = vm.envAddress("GENESIS_REWARD_POOL");
        address[] memory tokens = _parseAddressList(vm.envString("GENESIS_STAKE_TOKENS"));
        uint256[] memory weights = _parseUintList(vm.envString("GENESIS_ALLOC_POINTS"));
        require(tokens.length == weights.length, "GENESIS_STAKE_TOKENS and GENESIS_ALLOC_POINTS must be parallel");
        require(tokens.length > 0, "No tokens to register");

        console2.log("=== OpenGenesis ===");
        console2.log("chain id:", block.chainid);
        console2.log("pool:    ", pool);
        console2.log("entries: ", tokens.length);

        vm.startBroadcast(pk);
        GenesisRewardPool g = GenesisRewardPool(pool);
        for (uint256 i = 0; i < tokens.length; ++i) {
            g.add(weights[i], IERC20(tokens[i]), false, 0);
            console2.log("  + token:", tokens[i], "  weight:", weights[i]);
        }
        vm.stopBroadcast();

        console2.log("Genesis Pool is now open.");
    }

    /// @dev Tiny comma-split parser. Avoids pulling in a string library for one script.
    function _parseAddressList(string memory csv) internal view returns (address[] memory out) {
        string[] memory parts = _split(csv, ",");
        out = new address[](parts.length);
        for (uint256 i = 0; i < parts.length; ++i) {
            out[i] = vm.parseAddress(parts[i]);
        }
    }

    function _parseUintList(string memory csv) internal view returns (uint256[] memory out) {
        string[] memory parts = _split(csv, ",");
        out = new uint256[](parts.length);
        for (uint256 i = 0; i < parts.length; ++i) {
            out[i] = vm.parseUint(parts[i]);
        }
    }

    function _split(string memory s, string memory delim) internal pure returns (string[] memory) {
        bytes memory b = bytes(s);
        bytes memory d = bytes(delim);
        require(d.length == 1, "delim must be 1 char");
        uint256 count = 1;
        for (uint256 i = 0; i < b.length; ++i) if (b[i] == d[0]) count++;

        string[] memory out = new string[](count);
        uint256 idx;
        uint256 start;
        for (uint256 i = 0; i <= b.length; ++i) {
            if (i == b.length || b[i] == d[0]) {
                bytes memory slice = new bytes(i - start);
                for (uint256 j = 0; j < slice.length; ++j) slice[j] = b[start + j];
                out[idx++] = string(slice);
                start = i + 1;
            }
        }
        return out;
    }
}
