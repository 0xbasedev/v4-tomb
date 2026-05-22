// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/**
 * @title ContractGuard
 * @notice "One block, one function" anti-front-run guard. Verbatim port of Tomb Finance's
 *         utils/ContractGuard.sol. Used by Treasury and Boardroom on user-facing mutative
 *         functions (buyBonds / redeemBonds / stake / withdraw / etc.) to prevent the same
 *         tx.origin or msg.sender from making more than one such call in a single block.
 *
 *         This is the original Tomb anti-MEV / anti-flashbot pattern. It is intentionally
 *         coarser than a per-function nonReentrant guard — it blocks even unrelated functions
 *         from being called twice in the same block by the same address.
 */
abstract contract ContractGuard {
    // block.number => (address => already-called?)
    mapping(uint256 => mapping(address => bool)) private _status;

    error SameBlockReentered();

    function checkSameOriginReentranted() internal view returns (bool) {
        return _status[block.number][tx.origin];
    }

    function checkSameSenderReentranted() internal view returns (bool) {
        return _status[block.number][msg.sender];
    }

    modifier onlyOneBlock() {
        if (checkSameOriginReentranted()) revert SameBlockReentered();
        if (checkSameSenderReentranted()) revert SameBlockReentered();
        _;
        _status[block.number][tx.origin] = true;
        _status[block.number][msg.sender] = true;
    }
}
