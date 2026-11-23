// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {NetworkConfig} from "./NetworkConfig.s.sol";

import {console2} from "forge-std/Script.sol";

import {Treasury} from "../src/core/Treasury.sol";
import {PegDefenseHook} from "../src/hooks/PegDefenseHook.sol";

/**
 * @title KeeperTick
 * @notice One-shot keeper pass. Each step no-ops cleanly when there is nothing to do, so
 *         the script is safe to run on any schedule and to re-run after a partial failure.
 *
 *         1. **Epoch** — call `treasury.allocateSeigniorage()` once past `nextEpochPoint`.
 *            That call refreshes the Oracle's TWAP inside the same tx.
 *
 *         2. **Fire Tax ratchet** — call `hook.pokeTaxRate()` when a sync would change
 *            anything: raise the rate, open a seven-hour recovery window, or complete one.
 *            Without this a window only opens at the next trade.
 *
 *         3. **Deferred tax** — when the hook holds tax as PoolManager claims, redeem as
 *            much as reserves allow with `hook.settleDeferredTax()`. Settlement is partial
 *            by design and a call that can settle nothing is a no-op, so retries are safe.
 *
 *         Monitoring, surfaced through the run log and exit status:
 *           - Outstanding deferred tax after the pass is printed as a GitHub Actions
 *             `::warning::`, split into burn and Treasury amounts.
 *           - Claims that no longer cover the outstanding tax are an accounting breach:
 *             the script REVERTS so the scheduled run goes red.
 *
 *         Everything here is permissionless. Before `nextEpochPoint` only Trustees can
 *         advance the epoch, which doesn't apply to the keeper wallet.
 *
 *         Required env vars:
 *           KEEPER_PRIVATE_KEY  — wallet that signs. Needs ETH for gas only. Should NOT
 *                                  have any admin role on protocol contracts.
 *           Treasury and hook addresses are resolved from the selected manifest deployment.
 *
 *         Example:
 *           export KEEPER_PRIVATE_KEY=0x...
 *           forge script script/KeeperTick.s.sol --rpc-url "$RPC_URL" --broadcast --slow
 */
contract KeeperTick is NetworkConfig {
    error DeferredTaxUnderCollateralized(uint256 owed, uint256 claimsHeld);

    function run() external {
        _network();
        uint256 pk = vm.envUint("KEEPER_PRIVATE_KEY");

        console2.log("=== KeeperTick ===");
        console2.log("chain id:        ", block.chainid);
        console2.log("block.timestamp: ", block.timestamp);

        _tickEpoch(pk, Treasury(_deployment("treasury")));

        PegDefenseHook hook = PegDefenseHook(_deployment("hook"));
        if (!hook.bound()) {
            console2.log("Hook not bound to a pool yet; skipping tax steps.");
            return;
        }
        _syncTaxRate(pk, hook);
        _settleDeferredTax(pk, hook);
    }

    function _tickEpoch(
        uint256 pk,
        Treasury t
    ) internal {
        uint256 nextPoint = t.nextEpochPoint();
        console2.log("-- epoch --");
        console2.log("treasury:        ", address(t));
        console2.log("current epoch:   ", t.epoch());
        console2.log("next epoch at:   ", nextPoint);

        if (block.timestamp < nextPoint) {
            console2.log("Not yet. Next tick in (sec):", nextPoint - block.timestamp);
            return;
        }

        vm.startBroadcast(pk);
        t.allocateSeigniorage();
        vm.stopBroadcast();
        console2.log("Epoch advanced to:", t.epoch());
    }

    function _syncTaxRate(
        uint256 pk,
        PegDefenseHook hook
    ) internal {
        uint256 inForce = hook.taxRate();
        uint256 afterSync = hook.currentTaxRate();
        (uint256 toRate, uint256 readyAt) = hook.pendingTaxDecrease();
        bool windowWouldOpen = readyAt != 0 && hook.taxRecoveryStartedAt() == 0;

        console2.log("-- fire tax --");
        console2.log("tax enabled:     ", hook.autoCalculateTax());
        console2.log("rate in force:   ", inForce);
        console2.log("schedule target: ", hook.targetTaxRate());
        if (readyAt != 0) {
            console2.log("pending decrease to (bps):", toRate);
            console2.log("earliest at:              ", readyAt);
        }

        if (afterSync == inForce && !windowWouldOpen) {
            console2.log("Ratchet up to date.");
            return;
        }

        vm.startBroadcast(pk);
        hook.pokeTaxRate();
        vm.stopBroadcast();
        console2.log("Ratchet synced. Rate now:", hook.taxRate());
    }

    function _settleDeferredTax(
        uint256 pk,
        PegDefenseHook hook
    ) internal {
        (uint256 pendingBurn, uint256 pendingRoute, uint256 claimsHeld, uint256 settleableNow) =
            hook.deferredTaxStatus();
        uint256 owed = pendingBurn + pendingRoute;

        console2.log("-- deferred tax --");
        console2.log("pending burn:    ", pendingBurn);
        console2.log("pending treasury:", pendingRoute);
        console2.log("claims held:     ", claimsHeld);
        console2.log("settleable now:  ", settleableNow);

        // Claims must always cover what is owed. If they do not, stop loudly rather than
        // settle against a shortfall.
        if (claimsHeld < owed) revert DeferredTaxUnderCollateralized(owed, claimsHeld);

        if (owed == 0) {
            console2.log("Nothing deferred.");
            return;
        }
        if (settleableNow == 0) {
            console2.log("::warning::Deferred tax outstanding but no reserves to settle against; will retry.");
            return;
        }

        vm.startBroadcast(pk);
        (uint256 burned, uint256 routed) = hook.settleDeferredTax();
        vm.stopBroadcast();
        console2.log("burned:          ", burned);
        console2.log("sent to treasury:", routed);

        uint256 remaining = hook.pendingTaxBurn() + hook.pendingTaxRoute();
        if (remaining != 0) {
            console2.log("::warning::Deferred tax partially settled; remainder will retry. Outstanding:", remaining);
        }
    }
}
