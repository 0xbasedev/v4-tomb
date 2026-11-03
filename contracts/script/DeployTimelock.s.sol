// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {NetworkConfig} from "./NetworkConfig.s.sol";

import {console2} from "forge-std/Script.sol";

import {Timelock} from "../src/governance/Timelock.sol";

/**
 * @title DeployTimelock
 * @notice Deploys the Timelock that will own every admin-bearing protocol contract after
 *         Sprint 14's governance ceremony. Standalone from `Deploy.s.sol` because the
 *         Timelock is added AFTER the initial deploy (the original deploy used the
 *         deployer EOA as admin everywhere).
 *
 *         See docs/GOVERNANCE.md for the full ceremony.
 *
 *         Required env vars:
 *           DEPLOYER_PRIVATE_KEY — signer of the deploy.
 *           TIMELOCK_ADMIN       — initial admin of the Timelock (EOA or multisig).
 *                                  This address queues + executes Timelock transactions.
 *
 *         Optional env var:
 *           TIMELOCK_DELAY — seconds; bounded to Timelock.MINIMUM_DELAY..MAXIMUM_DELAY
 *                            (1 day .. 30 days). Defaults to 86_400 (24h) for mainnet
 *                            production. For testnet ergonomic experiments set this
 *                            to MINIMUM_DELAY = 86_400 still — anything shorter is
 *                            rejected by the Timelock constructor.
 *
 *         Commands:
 *           forge script script/DeployTimelock.s.sol --rpc-url "$RPC_URL" --broadcast --verify
 *           forge script script/DeployTimelock.s.sol --rpc-url "$RPC_URL" --broadcast --verify
 */
contract DeployTimelock is NetworkConfig {
    Timelock public timelock;

    function run() external {
        _network();
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.envAddress("TIMELOCK_ADMIN");
        uint256 delay = vm.envOr("TIMELOCK_DELAY", uint256(1 days));

        console2.log("=== DeployTimelock ===");
        console2.log("chain id:    ", block.chainid);
        console2.log("admin:       ", admin);
        console2.log("delay (sec): ", delay);

        vm.startBroadcast(pk);
        timelock = new Timelock(admin, delay);
        vm.stopBroadcast();

        console2.log("Timelock:    ", address(timelock));
        console2.log("\nNext: run script/RotateGovernanceQueue.s.sol to transfer ownership of");
        console2.log("every Ownable2Step contract + set Treasury/reward-pool operator to this Timelock.");
    }
}
