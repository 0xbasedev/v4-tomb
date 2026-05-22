// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title Estate
 * @notice $ESTATE — the share / governance side of the Old Money trust. Holders earn $OLDM
 *         seigniorage during expansion epochs by staking $ESTATE in TheClub (the Boardroom).
 * @dev    Tomb-Finance analog: TSHARE.
 *
 *         Supply model:
 *         - Fixed max supply of 80,000 $ESTATE. There is no `mint` function. Total supply
 *           is materialized exactly once via `distribute`, which is owner-callable a single
 *           time and mints the full 80,000 across three recipients in a 60/20/20 split:
 *             - 48,000 (60%) to Distributor — community LP / staking rewards pools.
 *             - 16,000 (20%) to a team VestingWallet — vested 12 months linear.
 *             - 16,000 (20%) to Treasury — endowment for protocol operations.
 *         - Burnable: holders can burn their own $ESTATE (`burn`) or another's via
 *           allowance (`burnFrom`). Burning permanently reduces supply.
 *         - Pausable by a Guardian role distinct from owner, per the same security
 *           posture as OldMoney: never concentrate freeze + governance in one key.
 *
 *         Key invariants:
 *         - `totalSupply()` <= MAX_SUPPLY at all times.
 *         - After `distribute`, `totalSupply()` == MAX_SUPPLY (less any subsequent burns).
 *         - `distribute` can be called at most once.
 *         - COMMUNITY_ALLOC + TEAM_ALLOC + TREASURY_ALLOC == MAX_SUPPLY (asserted at deploy).
 */
contract Estate is ERC20Burnable, ERC20Pausable, ERC20Permit, Ownable2Step {
    /// @notice Hard cap on $ESTATE supply.
    uint256 public constant MAX_SUPPLY = 80_000 ether;

    /// @notice 60% of MAX_SUPPLY → community LP / staking rewards.
    uint256 public constant COMMUNITY_ALLOC = 48_000 ether;

    /// @notice 20% of MAX_SUPPLY → team, locked in a VestingWallet for 12 months linear.
    uint256 public constant TEAM_ALLOC = 16_000 ether;

    /// @notice 20% of MAX_SUPPLY → Treasury endowment.
    uint256 public constant TREASURY_ALLOC = 16_000 ether;

    /// @notice Pause authority. Distinct from owner; intended for a Guardian multisig.
    address public guardian;

    /// @notice True once `distribute` has been called. Prevents re-distribution.
    bool public distributed;

    /// @notice Emitted exactly once, when the genesis distribution is executed.
    event Distributed(address indexed distributor, address indexed teamVesting, address indexed treasury);

    /// @notice Emitted when the guardian address is rotated.
    event GuardianSet(address indexed previousGuardian, address indexed newGuardian);

    error NotGuardian();
    error ZeroAddress();
    error AlreadyDistributed();
    error AllocationMismatch();

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    constructor(
        address initialOwner
    ) ERC20("Estate", "ESTATE") ERC20Permit("Estate") Ownable(initialOwner) {
        // Compile-time-ish sanity: the three allocations must sum to MAX_SUPPLY.
        // Cheap belt-and-suspenders against future edits to the constants.
        if (COMMUNITY_ALLOC + TEAM_ALLOC + TREASURY_ALLOC != MAX_SUPPLY) {
            revert AllocationMismatch();
        }
    }

    // ---------------------------------------------------------------------
    // Authority rotation
    // ---------------------------------------------------------------------

    /// @notice Set the Guardian — the only address allowed to pause/unpause $ESTATE.
    /// @dev Owner-only. Production guardian is a multisig distinct from owner.
    function setGuardian(
        address newGuardian
    ) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        address previous = guardian;
        guardian = newGuardian;
        emit GuardianSet(previous, newGuardian);
    }

    // ---------------------------------------------------------------------
    // Pause control
    // ---------------------------------------------------------------------

    function pause() external onlyGuardian {
        _pause();
    }

    function unpause() external onlyGuardian {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Genesis distribution
    // ---------------------------------------------------------------------

    /// @notice Mint the full 80,000 $ESTATE supply across the three genesis recipients.
    /// @dev One-shot, owner-only. After this call, no further $ESTATE can be minted.
    ///      The caller is responsible for deploying `teamVesting` as a properly-configured
    ///      OpenZeppelin VestingWallet with the team beneficiary, the launch timestamp,
    ///      and a 12-month linear cliff/vest duration.
    /// @param distributor Receives `COMMUNITY_ALLOC` for LP and staking rewards programs.
    /// @param teamVesting OpenZeppelin VestingWallet holding `TEAM_ALLOC` for the team.
    /// @param treasury Receives `TREASURY_ALLOC` for the protocol endowment.
    function distribute(
        address distributor,
        address teamVesting,
        address treasury
    ) external onlyOwner {
        if (distributed) revert AlreadyDistributed();
        if (distributor == address(0) || teamVesting == address(0) || treasury == address(0)) {
            revert ZeroAddress();
        }

        distributed = true;

        _mint(distributor, COMMUNITY_ALLOC);
        _mint(teamVesting, TEAM_ALLOC);
        _mint(treasury, TREASURY_ALLOC);

        emit Distributed(distributor, teamVesting, treasury);
    }

    // ---------------------------------------------------------------------
    // OZ v5 inheritance resolution
    // ---------------------------------------------------------------------

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20, ERC20Pausable) {
        super._update(from, to, value);
    }
}
