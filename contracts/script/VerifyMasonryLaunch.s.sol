// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Create3Config} from "./Create3Config.s.sol";

interface IBoundHook {
    function rangeManager() external view returns (address);
}

/// @notice Post-launch (or dry-run) gate: every published address has code, both tax hooks carry the
/// v4 permission bits, and each range manager is bound to its hook. Any miss reverts.
contract VerifyMasonryLaunch is Create3Config {
    error WrongChain(uint256 expected, uint256 actual);
    error NoCode(string role, address at);
    error BadHookBits(string role, address at);
    error Unbound(string hookRole, address bound, address expected);

    function run() external view {
        string memory config = vm.readFile(vm.envString("MASONRY_CREATE3_CONFIG"));
        uint256 chainId = vm.parseJsonUint(config, ".chainId");
        if (chainId != block.chainid) revert WrongChain(chainId, block.chainid);
        _readCreate3(config, "$"); // factory address + runtime hash + deployer + releaseId
        string[] memory roles = vm.parseJsonKeys(config, ".addresses");
        for (uint256 i; i < roles.length; ++i) {
            address a = vm.parseJsonAddress(config, string.concat(".addresses.", roles[i]));
            if (a.code.length == 0) revert NoCode(roles[i], a);
            bytes32 h = keccak256(bytes(roles[i]));
            if (
                (h == keccak256("masonryTaxHook") || h == keccak256("masonryShareTaxHook"))
                    && uint160(a) & 0x3fff != 0x35c8
            ) {
                revert BadHookBits(roles[i], a);
            }
        }
        _checkBind(config, "masonryLevelRangeManager", "masonryTaxHook");
        _checkBind(config, "masonrySquareRangeManager", "masonryShareTaxHook");
    }

    function _checkBind(
        string memory config,
        string memory rmRole,
        string memory hookRole
    ) internal view {
        string memory rmKey = string.concat(".addresses.", rmRole);
        string memory hookKey = string.concat(".addresses.", hookRole);
        if (!vm.keyExistsJson(config, rmKey) && !vm.keyExistsJson(config, hookKey)) return;
        address rm = vm.parseJsonAddress(config, rmKey); // reverts if one half of the pair is missing
        address hook = vm.parseJsonAddress(config, hookKey);
        address bound = IBoundHook(hook).rangeManager();
        if (bound != rm) revert Unbound(hookRole, bound, rm);
    }
}
