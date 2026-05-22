// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IDistributor} from "../interfaces/IDistributor.sol";

/**
 * @title Distributor
 * @notice Tiny aggregator. Holds a list of contracts implementing [[IDistributor]] and a
 *         single public `distribute()` that calls each in order. Used in the deploy
 *         sequence to bundle the various one-shot mints (OLDM genesis pool, OLDM main pool,
 *         OLDM airdrop, ESTATE farming pool) into a single transaction.
 * @dev    Verbatim port of Tomb Finance's Distributor.sol (bombmoney/bomb-contracts). The
 *         only deltas from Tomb are non-logic-changing: 0.6.12 → 0.8.26 and ++i over i++
 *         for the loop counter.
 *
 *         Permissionless `distribute()` is by design: anyone can poke the contract to
 *         trigger the one-shot fan-out. Each sub-distributor is itself gated to its own
 *         one-shot guard, so calling twice is a no-op on the second call.
 */
contract Distributor {
    IDistributor[] public distributors;

    constructor(
        IDistributor[] memory _distributors
    ) {
        distributors = _distributors;
    }

    function distribute() public {
        for (uint256 i = 0; i < distributors.length; ++i) {
            distributors[i].distribute();
        }
    }
}
