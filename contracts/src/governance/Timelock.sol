// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/**
 * @title Timelock
 * @notice Compound-style timelock. Direct port of Tomb Finance's Timelock.sol (which is
 *         itself a direct port of Compound Governor Bravo's Timelock, BSD-3-Clause).
 *
 * @dev    Production wiring: every privileged setter on Treasury / Boardroom / token
 *         contracts is rotated so that its `owner` (or `operator`) is THIS Timelock. The
 *         Timelock's own `admin` is a multisig. To change a parameter the multisig:
 *           1. Calls `queueTransaction(target, value, signature, data, eta)` where
 *              `eta >= now + delay`.
 *           2. Waits until `block.timestamp >= eta`.
 *           3. Calls `executeTransaction(...)` with the same args within
 *              `[eta, eta + GRACE_PERIOD]`.
 *         The Timelock then calls `target.call{value: value}(...)` with the abi-encoded
 *         function selector + data.
 *
 *         `setDelay` and `setPendingAdmin` can only be called BY the Timelock itself —
 *         i.e., they must themselves be routed through the queue/execute cycle. This is
 *         the mechanism's commitment device: even an admin who wants to shorten the delay
 *         must wait the current delay before doing so.
 *
 *         Modernizations from Tomb (no logic changes):
 *         - Solidity 0.6.12 → 0.8.26; SafeMath dropped.
 *         - `require` strings → custom errors.
 *         - Function visibility kept as `public` to match Tomb (some can be `external`,
 *           kept public for verbatim signature match).
 */
contract Timelock {
    uint256 public constant GRACE_PERIOD = 14 days;
    uint256 public constant MINIMUM_DELAY = 1 days;
    uint256 public constant MAXIMUM_DELAY = 30 days;

    address public admin;
    address public pendingAdmin;
    uint256 public delay;

    mapping(bytes32 => bool) public queuedTransactions;

    event NewAdmin(address indexed newAdmin);
    event NewPendingAdmin(address indexed newPendingAdmin);
    event NewDelay(uint256 indexed newDelay);
    event QueueTransaction(
        bytes32 indexed txHash, address indexed target, uint256 value, string signature, bytes data, uint256 eta
    );
    event CancelTransaction(
        bytes32 indexed txHash, address indexed target, uint256 value, string signature, bytes data, uint256 eta
    );
    event ExecuteTransaction(
        bytes32 indexed txHash, address indexed target, uint256 value, string signature, bytes data, uint256 eta
    );

    error DelayBelowMinimum();
    error DelayAboveMaximum();
    error NotAdmin();
    error NotPendingAdmin();
    error CallMustComeFromTimelock();
    error EtaTooSoon();
    error TransactionNotQueued();
    error TransactionNotMature();
    error TransactionStale();
    error TransactionFailed();

    constructor(
        address admin_,
        uint256 delay_
    ) {
        if (delay_ < MINIMUM_DELAY) revert DelayBelowMinimum();
        if (delay_ > MAXIMUM_DELAY) revert DelayAboveMaximum();
        admin = admin_;
        delay = delay_;
    }

    /// @notice Allow the Timelock to hold ETH (some queued transactions may need to forward value).
    receive() external payable {}

    // --------------------------------------------------------------------
    // Self-only setters (must be routed through queue/execute)
    // --------------------------------------------------------------------

    function setDelay(
        uint256 delay_
    ) public {
        if (msg.sender != address(this)) revert CallMustComeFromTimelock();
        if (delay_ < MINIMUM_DELAY) revert DelayBelowMinimum();
        if (delay_ > MAXIMUM_DELAY) revert DelayAboveMaximum();
        delay = delay_;
        emit NewDelay(delay_);
    }

    function setPendingAdmin(
        address pendingAdmin_
    ) public {
        if (msg.sender != address(this)) revert CallMustComeFromTimelock();
        pendingAdmin = pendingAdmin_;
        emit NewPendingAdmin(pendingAdmin_);
    }

    /// @notice Two-step admin transfer: the queued `setPendingAdmin` proposes; the new
    ///         admin claims by calling this directly (no delay on the claim).
    function acceptAdmin() public {
        if (msg.sender != pendingAdmin) revert NotPendingAdmin();
        admin = msg.sender;
        pendingAdmin = address(0);
        emit NewAdmin(admin);
    }

    // --------------------------------------------------------------------
    // Queue / cancel / execute
    // --------------------------------------------------------------------

    function queueTransaction(
        address target,
        uint256 value,
        string memory signature,
        bytes memory data,
        uint256 eta
    ) public returns (bytes32) {
        if (msg.sender != admin) revert NotAdmin();
        if (eta < block.timestamp + delay) revert EtaTooSoon();

        bytes32 txHash = keccak256(abi.encode(target, value, signature, data, eta));
        queuedTransactions[txHash] = true;

        emit QueueTransaction(txHash, target, value, signature, data, eta);
        return txHash;
    }

    function cancelTransaction(
        address target,
        uint256 value,
        string memory signature,
        bytes memory data,
        uint256 eta
    ) public {
        if (msg.sender != admin) revert NotAdmin();

        bytes32 txHash = keccak256(abi.encode(target, value, signature, data, eta));
        queuedTransactions[txHash] = false;

        emit CancelTransaction(txHash, target, value, signature, data, eta);
    }

    function executeTransaction(
        address target,
        uint256 value,
        string memory signature,
        bytes memory data,
        uint256 eta
    ) public payable returns (bytes memory) {
        if (msg.sender != admin) revert NotAdmin();

        bytes32 txHash = keccak256(abi.encode(target, value, signature, data, eta));
        if (!queuedTransactions[txHash]) revert TransactionNotQueued();
        if (block.timestamp < eta) revert TransactionNotMature();
        if (block.timestamp > eta + GRACE_PERIOD) revert TransactionStale();

        queuedTransactions[txHash] = false;

        bytes memory callData;
        if (bytes(signature).length == 0) {
            callData = data;
        } else {
            callData = abi.encodePacked(bytes4(keccak256(bytes(signature))), data);
        }

        (bool success, bytes memory returnData) = target.call{value: value}(callData);
        if (!success) revert TransactionFailed();

        emit ExecuteTransaction(txHash, target, value, signature, data, eta);
        return returnData;
    }
}
