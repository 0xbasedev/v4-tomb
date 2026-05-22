// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Trustees} from "../governance/Trustees.sol";

/**
 * @title OldMoney
 * @notice $MONEY — the algorithmic stable side of the Old Money trust. Pegged to 1 WETH TWAP on Base.
 * @dev    Direct port of Tomb Finance's BOMB token (Bomb.sol in bombmoney/bomb-contracts),
 *         with one deliberate omission: the in-contract tax mechanism (TaxOffice / TaxOracle /
 *         taxTiers / `_transferWithTax` override of `transferFrom`) is REMOVED. Peg defense and
 *         contraction taxation are handled by a Uniswap V4 hook (PegDefenseHook) attached to the
 *         MONEY/WETH pool. The V4 hook taxes pool swaps only, not wallet-to-wallet transfers —
 *         this is a behavior change vs Tomb and the explicit point of the V4 integration.
 *
 *         Non-logic-changing modernizations from Tomb's original:
 *           - Solidity 0.6.12 → 0.8.26 (built-in overflow checks; SafeMath dropped).
 *           - OZ v4 ERC20Burnable → OZ v5 ERC20Burnable.
 *           - Single-step Ownable (via Tomb's `Operator`) → Ownable2Step (via [[Trustees]]).
 *           - `require` strings → custom errors.
 *           - Added `ERC20Permit` (EIP-2612) for gasless approvals — additive, no existing
 *             behavior changed.
 *
 *         Genesis distribution (matches Tomb's BOMB exact numbers):
 *           - 11,000 MONEY → genesis pool (24h zero-LP boot)
 *           - 140,000 MONEY → main reward pool (days 2-5)
 *           - 9,000 MONEY → airdrop wallet
 *           Constructor additionally mints 1 MONEY to the initial owner for initial LP setup
 *           (matches Tomb's deploy-time seed mint).
 *
 *         Trustees ( = Tomb's operator) has unilateral mint and burnFrom authority. Wallet-level
 *         self-burn (`burn`) is public.
 */
contract OldMoney is ERC20Burnable, ERC20Permit, Trustees {
    using SafeERC20 for IERC20;

    /// @notice Initial mint to the genesis pool (24h zero-LP boot).
    uint256 public constant INITIAL_GENESIS_POOL_DISTRIBUTION = 11_000 ether;

    /// @notice Initial mint to the main MONEY-WETH LP reward pool (days 2-5).
    uint256 public constant INITIAL_MAIN_POOL_DISTRIBUTION = 140_000 ether;

    /// @notice Initial mint to the airdrop wallet.
    uint256 public constant INITIAL_AIRDROP_WALLET_DISTRIBUTION = 9000 ether;

    /// @notice True after `distributeReward` has been called. One-shot.
    bool public rewardPoolDistributed;

    /// @notice Emitted exactly once when the genesis distribution executes.
    event RewardPoolDistributed(address indexed genesisPool, address indexed mainPool, address indexed airdropWallet);

    /// @notice Themed alias emitted alongside the standard Transfer(0, to, amount) on every mint.
    event Coined(address indexed to, uint256 amount);

    /// @notice Emitted by `governanceRecoverUnsupported` when stuck tokens are rescued.
    event UnsupportedTokenRecovered(IERC20 indexed token, uint256 amount, address indexed to);

    error AlreadyDistributed();
    error ZeroAddress();

    constructor() ERC20("Old Money", "MONEY") ERC20Permit("Old Money") Trustees() {
        // Tomb-faithful: mint 1 unit to the deployer for initial pool setup / sanity check.
        _mint(msg.sender, 1 ether);
    }

    // ---------------------------------------------------------------------
    // Trustees-only supply control (matches Tomb's onlyOperator surface)
    // ---------------------------------------------------------------------

    /// @notice Mint MONEY. Returns true if the recipient's balance actually increased.
    /// @dev Tomb signature: `mint(address recipient_, uint256 amount_) returns (bool)`.
    function mint(
        address recipient,
        uint256 amount
    ) public onlyTrustees returns (bool) {
        uint256 balanceBefore = balanceOf(recipient);
        _mint(recipient, amount);
        emit Coined(recipient, amount);
        return balanceOf(recipient) > balanceBefore;
    }

    /// @notice Burn MONEY from an arbitrary account (subject to the standard ERC20 allowance check).
    /// @dev Trustees-only. Tomb's `BBond.burnFrom` and `Bomb.burnFrom` both gate this to operator;
    ///      the standard `ERC20Burnable.burnFrom` is open to any approved spender. Restricting
    ///      preserves the property that only the protocol mechanism can call `burnFrom`.
    function burnFrom(
        address account,
        uint256 amount
    ) public override onlyTrustees {
        super.burnFrom(account, amount);
    }

    /// @notice Burn MONEY from the caller's own balance. Public — anyone can opt out by burning.
    /// @dev Override preserves Tomb's explicit public restatement of the inherited symbol.
    function burn(
        uint256 amount
    ) public override {
        super.burn(amount);
    }

    // ---------------------------------------------------------------------
    // One-shot genesis distribution
    // ---------------------------------------------------------------------

    /// @notice Mint the three Tomb-style initial allocations to their respective recipients.
    ///         Callable at most once by trustees.
    /// @param genesisPool   Receives `INITIAL_GENESIS_POOL_DISTRIBUTION`.
    /// @param mainPool      Receives `INITIAL_MAIN_POOL_DISTRIBUTION`.
    /// @param airdropWallet Receives `INITIAL_AIRDROP_WALLET_DISTRIBUTION`.
    function distributeReward(
        address genesisPool,
        address mainPool,
        address airdropWallet
    ) external onlyTrustees {
        if (rewardPoolDistributed) revert AlreadyDistributed();
        if (genesisPool == address(0) || mainPool == address(0) || airdropWallet == address(0)) {
            revert ZeroAddress();
        }

        rewardPoolDistributed = true;
        _mint(genesisPool, INITIAL_GENESIS_POOL_DISTRIBUTION);
        _mint(mainPool, INITIAL_MAIN_POOL_DISTRIBUTION);
        _mint(airdropWallet, INITIAL_AIRDROP_WALLET_DISTRIBUTION);

        emit RewardPoolDistributed(genesisPool, mainPool, airdropWallet);
    }

    // ---------------------------------------------------------------------
    // Stuck-token rescue
    // ---------------------------------------------------------------------

    /// @notice Rescue an arbitrary ERC20 mistakenly sent to this contract.
    /// @dev Matches Tomb's `governanceRecoverUnsupported`. Uses SafeERC20 because the recovered
    ///      token may be USDT-shaped (no boolean return) per ETHSKILLS security guidance.
    function governanceRecoverUnsupported(
        IERC20 token,
        uint256 amount,
        address to
    ) external onlyTrustees {
        token.safeTransfer(to, amount);
        emit UnsupportedTokenRecovered(token, amount, to);
    }
}
