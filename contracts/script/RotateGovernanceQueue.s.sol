// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {NetworkConfig} from "./NetworkConfig.s.sol";

import {console2} from "forge-std/Script.sol";

import {PegToken} from "../src/tokens/PegToken.sol";
import {ShareToken} from "../src/tokens/ShareToken.sol";
import {Treasury} from "../src/core/Treasury.sol";
import {Timelock} from "../src/governance/Timelock.sol";
import {GenesisRewardPool} from "../src/distribution/GenesisRewardPool.sol";
import {PegFarm} from "../src/distribution/PegFarm.sol";
import {ShareFarm} from "../src/distribution/ShareFarm.sol";
import {PegDefenseHook} from "../src/hooks/PegDefenseHook.sol";
import {Oracle} from "../src/oracle/Oracle.sol";
import {ShareBuybackHook} from "../src/hooks/ShareBuybackHook.sol";

/**
 * @title RotateGovernanceQueue
 * @notice Stage 2 of the governance ceremony. Run after `Deploy.s.sol` and
 *         `DeployTimelock.s.sol`. Atomically:
 *
 *           1. Transfers ownership of every Ownable2Step contract (tokens + hook) to the
 *              Timelock by calling `transferOwnership`. This sets `pendingOwner = timelock`;
 *              the Timelock must explicitly accept later.
 *           2. Rotates the hook's trustees to the Timelock (one-step). After this the
 *              deployer can no longer tune tax tiers / thresholds — Timelock controls.
 *           3. Calls `setOperator(timelock)` on Treasury and on each reward pool. These
 *              are one-step transfers — done immediately, irreversible from this side.
 *           4. Queues `acceptOwnership()` calls via `timelock.queueTransaction(...)` for
 *              every Ownable2Step contract.
 *
 *         After this script: the deployer EOA has lost all admin power on Treasury,
 *         reward pools, and hook trustees. Token ownership is suspended (pendingOwner
 *         set, but not yet accepted).
 *
 *         Run `RotateGovernanceExecute.s.sol` after the Timelock delay has elapsed to
 *         finalize the token ownership transfers.
 *
 *         Required env vars (every address comes from the prior deploy logs / DEPLOYED.md):
 *           DEPLOYER_PRIVATE_KEY
 *           TIMELOCK address is resolved from the selected manifest deployment.
 *           PEG address is resolved from the selected manifest deployment.
 *           SHARE address is resolved from the selected manifest deployment.
 *           HOOK address is resolved from the selected manifest deployment.
 *           TREASURY address is resolved from the selected manifest deployment.
 *           GENESIS_REWARD_POOL address is resolved from the selected manifest deployment.
 *           PEG_FARM address is resolved from the selected manifest deployment.
 *           SHARE_FARM address is resolved from the selected manifest deployment.
 *
 *         Optional:
 *           ETA — Unix timestamp for the queued acceptOwnership transactions. Must be
 *                 ≥ block.timestamp + timelock.delay(). Defaults to
 *                 block.timestamp + timelock.delay() + 60 seconds.
 */
contract RotateGovernanceQueue is NetworkConfig {
    function run() external {
        _network();
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");

        Timelock timelock = Timelock(payable(_deployment("timelock")));
        PegToken peg = PegToken(_deployment("peg"));
        ShareToken share = ShareToken(_deployment("share"));
        PegDefenseHook hook = PegDefenseHook(_deployment("hook"));
        ShareBuybackHook shareHook = ShareBuybackHook(_deployment("shareBuybackHook"));
        Treasury treasury = Treasury(_deployment("treasury"));
        Oracle oracle = Oracle(_deployment("oracle"));
        GenesisRewardPool gp = GenesisRewardPool(_deployment("genesisRewardPool"));
        PegFarm mp = PegFarm(_deployment("pegFarm"));
        ShareFarm sp = ShareFarm(_deployment("shareFarm"));

        uint256 defaultEta = block.timestamp + timelock.delay() + 60;
        uint256 eta = vm.envOr("ETA", defaultEta);

        console2.log("=== RotateGovernanceQueue ===");
        console2.log("Timelock:", address(timelock));
        console2.log("ETA (unix):", eta);

        vm.startBroadcast(pk);

        // Stage 2a: Ownable2Step transferOwnership (sets pendingOwner).
        peg.transferOwnership(address(timelock));
        share.transferOwnership(address(timelock));
        hook.transferOwnership(address(timelock));
        shareHook.transferOwnership(address(timelock));
        oracle.transferOwnership(address(timelock));

        // Stage 2b: PegDefenseHook trustees (one-step). After this the deployer can no
        // longer tune tax tiers — Timelock controls.
        hook.transferTrustees(address(timelock));
        shareHook.transferTrustees(address(timelock));
        // The Oracle's TWAP window and epoch setters steer expansion and the tax tier, so
        // they move behind the Timelock with everything else. They stay bounded either
        // way: the window is limited to 1-48 hours by the contract.
        oracle.transferTrustees(address(timelock));
        console2.log("rotated hook + share buyback hook trustees -> Timelock");

        // Stage 2c: single-step operator rotation on Treasury + reward pools.
        // Masonry stays with Treasury (intentional — protocol-internal).
        treasury.setOperator(address(timelock));
        gp.setOperator(address(timelock));
        mp.setOperator(address(timelock));
        sp.setOperator(address(timelock));
        console2.log("rotated Treasury + Genesis/Main/Share reward pool operators -> Timelock");

        // Stage 2d: queue acceptOwnership for each Ownable2Step contract via Timelock.
        timelock.queueTransaction(address(peg), 0, "acceptOwnership()", bytes(""), eta);
        timelock.queueTransaction(address(share), 0, "acceptOwnership()", bytes(""), eta);
        timelock.queueTransaction(address(hook), 0, "acceptOwnership()", bytes(""), eta);
        timelock.queueTransaction(address(shareHook), 0, "acceptOwnership()", bytes(""), eta);
        timelock.queueTransaction(address(oracle), 0, "acceptOwnership()", bytes(""), eta);

        vm.stopBroadcast();

        console2.log("\nNext step (after eta):");
        console2.log("  forge script script/RotateGovernanceExecute.s.sol --rpc-url <chain> --broadcast");
        console2.log("  with ETA env var set to:", eta);
    }
}
