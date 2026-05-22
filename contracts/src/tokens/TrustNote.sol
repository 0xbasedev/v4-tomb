// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

import {Trustees} from "../governance/Trustees.sol";

/**
 * @title TrustNote
 * @notice $TRUSTNOTE — the contraction bond. During contraction epochs (TWAP < 1.0 WETH),
 *         users can burn $MONEY to mint $TRUSTNOTE at a discount. During the next expansion,
 *         trustees redeems $TRUSTNOTE for $MONEY at a premium via the Treasury.
 * @dev    Direct port of Tomb Finance's BBOND (BBond.sol in bombmoney/bomb-contracts).
 *
 *         Non-logic-changing modernizations:
 *           - 0.6.12 → 0.8.26 (built-in overflow checks).
 *           - OZ v4 → OZ v5 ERC20Burnable.
 *           - Single-step Ownable → Ownable2Step via [[Trustees]].
 *
 *         Strict-fidelity choices (NOT modernized beyond what Tomb does):
 *           - No `ERC20Permit`. BBond doesn't have it; bonds are minted/burned through the
 *             Treasury mechanism, not transferred wallet-to-wallet often enough to need permit.
 *           - No `governanceRecoverUnsupported`. BBond doesn't have it.
 *           - No initial mint in constructor. BBond starts at zero supply; bonds are
 *             minted on-demand during contraction.
 *           - No themed `Coined`/equivalent event. BBond emits only the standard Transfer
 *             event on mint — that's enough for indexers and matches Tomb's design.
 *
 *         Authority surface (matches BBond exactly):
 *           - `mint(recipient, amount)` returns (bool) — trustees-only.
 *           - `burn(amount)` — public; anyone can burn their own.
 *           - `burnFrom(account, amount)` — trustees-only (not general allowance-based).
 */
contract TrustNote is ERC20Burnable, Trustees {
    constructor() ERC20("Trust Note", "TRUSTNOTE") Trustees() {}

    /// @notice Mint $TRUSTNOTE to a recipient. Returns true if balance actually increased.
    function mint(
        address recipient,
        uint256 amount
    ) public onlyTrustees returns (bool) {
        uint256 balanceBefore = balanceOf(recipient);
        _mint(recipient, amount);
        return balanceOf(recipient) > balanceBefore;
    }

    /// @notice Burn $TRUSTNOTE from the caller's own balance.
    function burn(
        uint256 amount
    ) public override {
        super.burn(amount);
    }

    /// @notice Burn $TRUSTNOTE from an arbitrary account (subject to allowance). Trustees-only.
    function burnFrom(
        address account,
        uint256 amount
    ) public override onlyTrustees {
        super.burnFrom(account, amount);
    }
}
