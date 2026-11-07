// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";

/// @notice Masonry-only dry-run launcher documentation.
/// @dev This script never broadcasts and refuses to run if PRIVATE_KEY is set.
///      The executable simulation lives in
///      `contracts/test/integration/RobinhoodForkLaunch.t.sol`.
///
///      anvil --fork-url https://rpc.mainnet.chain.robinhood.com
///      forge test --match-contract RobinhoodForkLaunch --fork-url http://127.0.0.1:8545 -vvv
///
///      Do not pass --broadcast. Do not launch from Deploy.s.sol (legacy WETH/bond path).
contract LaunchMasonryDryRun is Script {
    error BroadcastCredentialsPresent();

    function run() external view {
        if (vm.envOr("PRIVATE_KEY", uint256(0)) != 0) revert BroadcastCredentialsPresent();
        console2.log("Masonry dry-run only. No broadcast.");
        console2.log("Fork Robinhood (4663) with anvil, then run RobinhoodForkLaunch tests.");
        console2.log("Legacy Deploy.s.sol (Treasury/Boardroom/TrustNote/PegDefenseHook) is not launch logic.");
    }
}
