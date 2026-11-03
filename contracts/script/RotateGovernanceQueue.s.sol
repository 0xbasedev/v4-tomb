// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {NetworkConfig} from "./NetworkConfig.s.sol";

import {console2} from "forge-std/Script.sol";

import {OldMoney} from "../src/tokens/OldMoney.sol";
import {Estate} from "../src/tokens/Estate.sol";
import {TrustNote} from "../src/tokens/TrustNote.sol";
import {Treasury} from "../src/core/Treasury.sol";
import {Timelock} from "../src/governance/Timelock.sol";
import {GenesisRewardPool} from "../src/distribution/GenesisRewardPool.sol";
import {MainRewardPool} from "../src/distribution/MainRewardPool.sol";
import {ShareRewardPool} from "../src/distribution/ShareRewardPool.sol";
import {PegDefenseHook} from "../src/hooks/PegDefenseHook.sol";

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
 *           MONEY address is resolved from the selected manifest deployment.
 *           ESTATE address is resolved from the selected manifest deployment.
 *           TRUSTNOTE address is resolved from the selected manifest deployment.
 *           HOOK address is resolved from the selected manifest deployment.
 *           TREASURY address is resolved from the selected manifest deployment.
 *           GENESIS_REWARD_POOL address is resolved from the selected manifest deployment.
 *           MAIN_REWARD_POOL address is resolved from the selected manifest deployment.
 *           SHARE_REWARD_POOL address is resolved from the selected manifest deployment.
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
        OldMoney money = OldMoney(_deployment("money"));
        Estate estate = Estate(_deployment("estate"));
        TrustNote trustnote = TrustNote(_deployment("trustNote"));
        PegDefenseHook hook = PegDefenseHook(_deployment("hook"));
        Treasury treasury = Treasury(_deployment("treasury"));
        GenesisRewardPool gp = GenesisRewardPool(_deployment("genesisRewardPool"));
        MainRewardPool mp = MainRewardPool(_deployment("mainRewardPool"));
        ShareRewardPool sp = ShareRewardPool(_deployment("shareRewardPool"));

        uint256 defaultEta = block.timestamp + timelock.delay() + 60;
        uint256 eta = vm.envOr("ETA", defaultEta);

        console2.log("=== RotateGovernanceQueue ===");
        console2.log("Timelock:", address(timelock));
        console2.log("ETA (unix):", eta);

        vm.startBroadcast(pk);

        // Stage 2a: Ownable2Step transferOwnership (sets pendingOwner).
        money.transferOwnership(address(timelock));
        estate.transferOwnership(address(timelock));
        trustnote.transferOwnership(address(timelock));
        hook.transferOwnership(address(timelock));
        console2.log("transferred Ownable2Step ownership of money/estate/trustnote/hook to Timelock");

        // Stage 2b: PegDefenseHook trustees (one-step). After this the deployer can no
        // longer tune tax tiers — Timelock controls.
        hook.transferTrustees(address(timelock));
        console2.log("rotated hook trustees -> Timelock");

        // Stage 2c: single-step operator rotation on Treasury + reward pools.
        // Boardroom stays with Treasury (intentional — protocol-internal).
        treasury.setOperator(address(timelock));
        gp.setOperator(address(timelock));
        mp.setOperator(address(timelock));
        sp.setOperator(address(timelock));
        console2.log("rotated Treasury + Genesis/Main/Share reward pool operators -> Timelock");

        // Stage 2d: queue acceptOwnership for each Ownable2Step contract via Timelock.
        timelock.queueTransaction(address(money), 0, "acceptOwnership()", bytes(""), eta);
        timelock.queueTransaction(address(estate), 0, "acceptOwnership()", bytes(""), eta);
        timelock.queueTransaction(address(trustnote), 0, "acceptOwnership()", bytes(""), eta);
        timelock.queueTransaction(address(hook), 0, "acceptOwnership()", bytes(""), eta);
        console2.log("queued acceptOwnership for money/estate/trustnote/hook with eta", eta);

        vm.stopBroadcast();

        console2.log("\nNext step (after eta):");
        console2.log("  forge script script/RotateGovernanceExecute.s.sol --rpc-url <chain> --broadcast");
        console2.log("  with ETA env var set to:", eta);
    }
}
