// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {NetworkConfig} from "./NetworkConfig.s.sol";

import {console2} from "forge-std/Script.sol";

import {Treasury} from "../src/core/Treasury.sol";
import {PegDefenseHook} from "../src/hooks/PegDefenseHook.sol";

/**
 * @title PostBootstrap
 * @notice One-shot script for the post-bootstrap configuration sweep. Runs the levers
 *         that should NOT be on during the 28-epoch bootstrap window:
 *
 *           1. Enable the PegDefenseHook's automatic sell-side tax.
 *           2. Set the daoFundSharedPercent + devFundSharedPercent on Treasury.
 *
 *         The hook tax is the Tomb-faithful peg-defense lever. The fund cuts are
 *         the seigniorage rake — set them to 0 if you want a community-only protocol;
 *         set them up to (3000, 1000) for the maximum Tomb-equivalent rake (30% / 10%).
 *
 *         Do NOT redirect hook.treasury() to a team wallet from here — that's a separate,
 *         conscious decision documented in LAUNCH_RUNBOOK.md §4.3. This script assumes
 *         the default (above-threshold tax accrues to the protocol Treasury).
 *
 *         Required env vars:
 *           DEPLOYER_PRIVATE_KEY  — operator signer
 *           TREASURY address is resolved from the selected manifest deployment.
 *           HOOK address is resolved from the selected manifest deployment.
 *           DAO_FUND              — daoFund recipient address (Treasury.setExtraFunds requires non-zero)
 *           DEV_FUND              — devFund recipient address (Treasury.setExtraFunds requires non-zero)
 *           DAO_FUND_PERCENT      — basis points, 0-3000 (0%, max 30%)
 *           DEV_FUND_PERCENT      — basis points, 0-1000 (0%, max 10%)
 *
 *         Optional:
 *           ENABLE_HOOK_TAX       — "1" enables, anything else skips. Default "1".
 *
 *         Example:
 *           export HOOK=0x8FF8...
 *           export DAO_FUND=0x...
 *           export DEV_FUND=0x...
 *           export DAO_FUND_PERCENT=3000   # 30%
 *           export DEV_FUND_PERCENT=1000   # 10%
 *           forge script script/PostBootstrap.s.sol --rpc-url "$RPC_URL" --broadcast
 *
 *         Reversibility: every lever this script touches is reversible by the operator
 *         (or post-Sprint-14 the Timelock) by calling the same setter with different
 *         values. Re-run the script with new env vars to update.
 */
contract PostBootstrap is NetworkConfig {
    function run() external {
        _network();
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address treasuryAddr = _deployment("treasury");
        address hookAddr = _deployment("hook");
        address daoFund = vm.envAddress("DAO_FUND");
        address devFund = vm.envAddress("DEV_FUND");
        uint256 daoPercent = vm.envUint("DAO_FUND_PERCENT");
        uint256 devPercent = vm.envUint("DEV_FUND_PERCENT");
        string memory taxFlag = vm.envOr("ENABLE_HOOK_TAX", string("1"));
        bool enableTax = keccak256(bytes(taxFlag)) == keccak256(bytes("1"));

        console2.log("=== PostBootstrap ===");
        console2.log("chain id:        ", block.chainid);
        console2.log("treasury:        ", treasuryAddr);
        console2.log("hook:            ", hookAddr);
        console2.log("daoFund:         ", daoFund);
        console2.log("devFund:         ", devFund);
        console2.log("daoFund %:       ", daoPercent);
        console2.log("devFund %:       ", devPercent);
        console2.log("enable hook tax: ", enableTax);

        Treasury t = Treasury(treasuryAddr);
        PegDefenseHook h = PegDefenseHook(hookAddr);

        // Sanity guard — refuse to run during bootstrap window. Operators who really
        // want to set these earlier can call the setters directly via cast.
        uint256 currentEpoch = t.epoch();
        uint256 bootstrapEpochs = t.bootstrapEpochs();
        require(
            currentEpoch >= bootstrapEpochs,
            "PostBootstrap: still in bootstrap window. Wait until epoch >= bootstrapEpochs, or call setters directly via cast if intentional."
        );

        vm.startBroadcast(pk);

        // Fund cuts. Treasury.setExtraFunds requires non-zero addresses even when
        // percent is 0 (it stores both). Bounds are enforced by the contract:
        // daoFundSharedPercent <= 3000, devFundSharedPercent <= 1000.
        t.setExtraFunds(daoFund, daoPercent, devFund, devPercent);
        console2.log("  setExtraFunds called.");

        if (enableTax) {
            h.setAutoCalculateTax(true);
            console2.log("  autoCalculateTax = true. Hook will tax MONEY sells per the 14-tier schedule.");
        } else {
            console2.log("  autoCalculateTax left untouched (ENABLE_HOOK_TAX != \"1\").");
        }

        vm.stopBroadcast();

        console2.log("\nPost-bootstrap configuration applied.");
        console2.log("Reversible: call setExtraFunds / setAutoCalculateTax with new values to update.");
    }
}
