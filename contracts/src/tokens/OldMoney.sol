// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title OldMoney
 * @notice $OLDM — the algorithmic stable side of the Old Money trust.
 *         Pegged to 1 cbETH TWAP on Base. Mint authority is gated to a single Trustees
 *         (Treasury) address; pause authority is held by a separate Guardian so that
 *         freezing transfers and governing the contract require two different keys.
 * @dev    Tomb-Finance analog: TOMB.
 *
 *         Security posture:
 *         - Trustees can mint, never burn from arbitrary holders. Users opt in to
 *           mechanism participation by approving Trustees; ERC20Burnable provides
 *           self-burn (`burn`) and allowance-based burn (`burnFrom`).
 *         - Guardian's only powers are pause / unpause. Owner cannot pause.
 *         - Ownable2Step prevents accidental loss of admin authority during rotations.
 *         - 18 decimals. cbETH is 18 decimals. There is no 6-decimal trap here, but
 *           every external integrator must still verify decimals at the boundary.
 *
 *         Key invariants (asserted in test/invariant/SupplyInvariants.t.sol):
 *         - `totalSupply()` equals Σ minted minus Σ burned across the lifetime of the contract.
 *         - Only `trustees` can successfully call `mint`.
 *         - Only `guardian` can call `pause` / `unpause`.
 *         - `setTrustees(0)` / `setGuardian(0)` revert.
 */
contract OldMoney is ERC20Burnable, ERC20Pausable, ERC20Permit, Ownable2Step {
    /// @notice Sole address authorized to mint OLDM (the Treasury contract).
    address public trustees;

    /// @notice Sole address authorized to pause / unpause OLDM. Should be a Guardian multisig.
    address public guardian;

    /// @notice Emitted when the trustees address is rotated.
    event TrusteesSet(address indexed previousTrustees, address indexed newTrustees);

    /// @notice Emitted when the guardian address is rotated.
    event GuardianSet(address indexed previousGuardian, address indexed newGuardian);

    /// @notice Emitted on every mint, in addition to the standard ERC20 Transfer(0, to, amount).
    ///         Themed alias for offchain consumers; indexers may listen for either.
    event Coined(address indexed to, uint256 amount);

    error NotTrustees();
    error NotGuardian();
    error ZeroAddress();

    modifier onlyTrustees() {
        if (msg.sender != trustees) revert NotTrustees();
        _;
    }

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    constructor(
        address initialOwner
    ) ERC20("Old Money", "OLDM") ERC20Permit("Old Money") Ownable(initialOwner) {}

    // ---------------------------------------------------------------------
    // Authority rotation
    // ---------------------------------------------------------------------

    /// @notice Set the Trustees — the only address allowed to mint OLDM.
    /// @dev Should be the Treasury contract. Owner-only; production owner is the Timelock.
    function setTrustees(
        address newTrustees
    ) external onlyOwner {
        if (newTrustees == address(0)) revert ZeroAddress();
        address previous = trustees;
        trustees = newTrustees;
        emit TrusteesSet(previous, newTrustees);
    }

    /// @notice Set the Guardian — the only address allowed to pause/unpause OLDM.
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
    // Supply control
    // ---------------------------------------------------------------------

    /// @notice Mint OLDM. Only callable by Trustees during expansion epochs.
    /// @param to Recipient of the freshly minted OLDM.
    /// @param amount Amount to mint (18-decimal).
    function mint(
        address to,
        uint256 amount
    ) external onlyTrustees {
        _mint(to, amount);
        emit Coined(to, amount);
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
