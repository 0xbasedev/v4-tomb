// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/**
 * @title IDistributor
 * @notice Tomb-shape interface for any contract that can be told to perform a one-shot
 *         distribution. The [[Distributor]] aggregator calls `distribute()` on a list of
 *         contracts implementing this interface, batching multiple distributions into one
 *         transaction.
 */
interface IDistributor {
    function distribute() external;
}
