// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

import {Timelock} from "../src/governance/Timelock.sol";

/**
 * @title RotateGovernanceExecute
 * @notice Stage 3 of the governance ceremony. Run AFTER the Timelock delay has elapsed.
 *         Executes the four queued `acceptOwnership()` transactions, finalizing the
 *         token + hook ownership transfer to the Timelock.
 *
 *         Required env vars:
 *           DEPLOYER_PRIVATE_KEY — must be the Timelock's admin (signer of the queue script).
 *           TIMELOCK
 *           MONEY
 *           ESTATE
 *           TRUSTNOTE
 *           HOOK
 *           ETA — Unix timestamp that was used in `RotateGovernanceQueue.s.sol`. Same value!
 *
 *         Must be invoked with `block.timestamp >= ETA` and within
 *         `block.timestamp <= ETA + Timelock.GRACE_PERIOD` (14 days).
 */
contract RotateGovernanceExecute is Script {
    function run() external {
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        Timelock timelock = Timelock(payable(vm.envAddress("TIMELOCK")));
        address money = vm.envAddress("MONEY");
        address estate = vm.envAddress("ESTATE");
        address trustnote = vm.envAddress("TRUSTNOTE");
        address hook = vm.envAddress("HOOK");
        uint256 eta = vm.envUint("ETA");

        console2.log("=== RotateGovernanceExecute ===");
        console2.log("Timelock:    ", address(timelock));
        console2.log("ETA (unix):  ", eta);
        console2.log("block.timestamp:", block.timestamp);

        require(block.timestamp >= eta, "RotateGovExec: too early");
        require(block.timestamp <= eta + timelock.GRACE_PERIOD(), "RotateGovExec: past grace period");

        vm.startBroadcast(pk);
        timelock.executeTransaction(money, 0, "acceptOwnership()", bytes(""), eta);
        timelock.executeTransaction(estate, 0, "acceptOwnership()", bytes(""), eta);
        timelock.executeTransaction(trustnote, 0, "acceptOwnership()", bytes(""), eta);
        timelock.executeTransaction(hook, 0, "acceptOwnership()", bytes(""), eta);
        vm.stopBroadcast();

        console2.log("\nGovernance ceremony complete. Timelock now owns money/estate/trustnote/hook,");
        console2.log("operator of Treasury and Genesis/Main/Share reward pools, and trustees of hook.");
        console2.log("Treasury still operates Boardroom (intentional). Wrapper has no admin (intentional).");
    }
}
