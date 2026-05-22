// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/**
 * @title HookMiner
 * @notice CREATE2 salt finder for Uniswap V4 hook deployments.
 *
 *         A V4 hook's permission set is encoded in the low 14 bits of its deployed address.
 *         To deploy the hook at a valid address you (a) pick a CREATE2 deployer, (b) try
 *         many salts until the resulting address has the right low-14-bit pattern, then
 *         (c) deploy via CREATE2 with that salt.
 *
 *         This library does step (b) in pure Solidity. For tests it runs in-test; for
 *         production deploys it runs inside the Forge script's `vm.startBroadcast()` block.
 *         A 14-bit pattern means roughly 1-in-16384 candidate salts work, so finding one
 *         is fast (~milliseconds in practice).
 */
library HookMiner {
    /// @notice Mask covering the 14 hook-permission flag bits at the low end of the address.
    uint160 internal constant FLAG_MASK = 0x3FFF;

    error UnableToFindAddress();

    /// @notice Find a salt such that CREATE2(deployer, salt, creationCode) produces an
    ///         address whose low 14 bits exactly equal `flags`.
    /// @param deployer The address that will call CREATE2 (typically the deploy script,
    ///                 or a deterministic deployer like 0x4e59b44847b379578588920cA78FbF26c0B4956C).
    /// @param flags    The required permission-bit pattern (e.g. AFTER_INIT | BEFORE_SWAP).
    /// @param creationCode The full creation code (init code + constructor args).
    /// @return hookAddress The CREATE2 address that matches.
    /// @return salt The salt to pass to CREATE2.
    function find(
        address deployer,
        uint160 flags,
        bytes memory creationCode
    ) internal pure returns (address hookAddress, bytes32 salt) {
        flags = flags & FLAG_MASK;
        bytes32 initCodeHash = keccak256(creationCode);

        for (uint256 i = 0; i < 200_000; ++i) {
            salt = bytes32(i);
            hookAddress =
                address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initCodeHash)))));
            if ((uint160(hookAddress) & FLAG_MASK) == flags) {
                return (hookAddress, salt);
            }
        }
        revert UnableToFindAddress();
    }
}
