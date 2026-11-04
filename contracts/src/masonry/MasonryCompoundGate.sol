// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice Shared, hard-coded three-hour compound gate for Genesis and Farms.
/// Both manual and auto-compound execution paths must call consume() with
/// the SAME pool key and beneficiary before any compounding effects.
/// @dev This contract is a reusable backend component; Genesis/Farm adapters
/// are not yet wired. Harvest-only and withdrawal paths never call consume().
contract MasonryCompoundGate is Ownable {
    uint256 public constant COOLDOWN = 3 hours;

    mapping(address executor => bool enabled) public authorizedExecutors;
    mapping(address beneficiary => mapping(bytes32 poolKey => uint256 unlockTimestamp)) public nextEligibleAt;

    error NotExecutor();
    error InvalidPool();
    error CooldownActive(uint256 eligibleAt);

    event ExecutorAuthorization(address indexed executor, bool enabled);
    event CompoundRecorded(address indexed beneficiary, bytes32 indexed poolKey, uint256 nextEligibleAt);

    constructor(
        address owner_
    ) Ownable(owner_) {}

    function setExecutor(
        address executor,
        bool enabled
    ) external onlyOwner {
        if (enabled && executor.code.length == 0) revert NotExecutor();
        authorizedExecutors[executor] = enabled;
        emit ExecutorAuthorization(executor, enabled);
    }

    function consume(
        address beneficiary,
        bytes32 poolKey
    ) external {
        if (!authorizedExecutors[msg.sender]) revert NotExecutor();
        if (beneficiary == address(0) || poolKey == bytes32(0)) revert InvalidPool();
        uint256 earliest = nextEligibleAt[beneficiary][poolKey];
        if (block.timestamp < earliest) revert CooldownActive(earliest);
        uint256 next = block.timestamp + COOLDOWN;
        nextEligibleAt[beneficiary][poolKey] = next;
        emit CompoundRecorded(beneficiary, poolKey, next);
    }

    function canCompound(
        address beneficiary,
        bytes32 poolKey
    ) external view returns (bool) {
        if (beneficiary == address(0) || poolKey == bytes32(0)) return false;
        return block.timestamp >= nextEligibleAt[beneficiary][poolKey];
    }
}
