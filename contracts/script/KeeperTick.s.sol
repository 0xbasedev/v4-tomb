// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {NetworkConfig} from "./NetworkConfig.s.sol";

import {console2} from "forge-std/Script.sol";

import {Treasury} from "../src/core/Treasury.sol";

/**
 * @title KeeperTick
 * @notice One-shot script that advances the Treasury's epoch if past nextEpochPoint.
 *
 *         The script does ONE thing: call `treasury.allocateSeigniorage()` post-epoch.
 *         That call internally invokes `_updateMoneyPrice()` (a `try { oracle.update() }
 *         catch {}` wrapper) so the Oracle's TWAP refreshes inside the same tx. No
 *         separate oracle.update() call needed from the keeper side.
 *
 *         Permissionless post-`treasury.nextEpochPoint()`. Before that point only Trustees
 *         can advance, which doesn't apply to the keeper wallet.
 *
 *         Designed for GitHub Actions / Defender / Gelato / cron — runs frequently
 *         (every 30 minutes is plenty for a 6h epoch), no-ops cleanly when there's
 *         nothing to do. The forge script returns successfully whether or not a
 *         transaction was broadcast.
 *
 *         Required env vars:
 *           KEEPER_PRIVATE_KEY  — wallet that signs the tick. Needs ETH for gas only.
 *                                  Should NOT have any admin role on protocol contracts.
 *           TREASURY address is resolved from the selected manifest deployment.
 *
 *         Example:
 *           export KEEPER_PRIVATE_KEY=0x...
 *           forge script script/KeeperTick.s.sol --rpc-url "$RPC_URL" --broadcast --slow
 */
contract KeeperTick is NetworkConfig {
    function run() external {
        _network();
        uint256 pk = vm.envUint("KEEPER_PRIVATE_KEY");
        address treasuryAddr = _deployment("treasury");
        Treasury t = Treasury(treasuryAddr);

        uint256 currentEpoch = t.epoch();
        uint256 nextPoint = t.nextEpochPoint();
        uint256 nowTs = block.timestamp;

        console2.log("=== KeeperTick ===");
        console2.log("chain id:        ", block.chainid);
        console2.log("treasury:        ", treasuryAddr);
        console2.log("current epoch:   ", currentEpoch);
        console2.log("next epoch at:   ", nextPoint);
        console2.log("block.timestamp: ", nowTs);

        if (nowTs < nextPoint) {
            uint256 wait = nextPoint - nowTs;
            console2.log("Not yet. Next tick in (sec):", wait);
            return;
        }

        // Past nextEpochPoint — broadcast the tick.
        vm.startBroadcast(pk);
        t.allocateSeigniorage();
        vm.stopBroadcast();

        console2.log("Epoch advanced to:", t.epoch());
    }
}
