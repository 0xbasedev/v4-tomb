// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ContractGuard} from "../libs/ContractGuard.sol";
import {ITreasury} from "../interfaces/ITreasury.sol";

/**
 * @title ShareWrapper
 * @notice Internal balance accounting for staked $ESTATE. Direct port of Tomb's same-named
 *         contract embedded in Boardroom.sol. Kept in the same file as the Boardroom to
 *         match Tomb's source layout one-for-one.
 */
abstract contract ShareWrapper {
    using SafeERC20 for IERC20;

    IERC20 public share;

    uint256 private _totalSupply;
    mapping(address => uint256) private _balances;

    function totalSupply() public view returns (uint256) {
        return _totalSupply;
    }

    function balanceOf(
        address account
    ) public view returns (uint256) {
        return _balances[account];
    }

    function stake(
        uint256 amount
    ) public virtual {
        _totalSupply += amount;
        _balances[msg.sender] += amount;
        share.safeTransferFrom(msg.sender, address(this), amount);
    }

    function withdraw(
        uint256 amount
    ) public virtual {
        uint256 memberShare = _balances[msg.sender];
        require(memberShare >= amount, "Boardroom: withdraw request greater than staked amount");
        _totalSupply -= amount;
        _balances[msg.sender] = memberShare - amount;
        share.safeTransfer(msg.sender, amount);
    }
}

/**
 * @title Boardroom
 * @notice $ESTATE-staking pool. Stakers earn $MONEY seigniorage minted by the Treasury during
 *         expansion epochs. Snapshot-based reward accounting matches the masterchef-derived
 *         pattern Tomb uses.
 * @dev    Direct port of Tomb Finance's Boardroom.sol (bombmoney/bomb-contracts).
 *
 *         Branded as "TheClub" in Old Money docs/UI; the on-chain class name is `Boardroom`
 *         to match Tomb's source one-for-one for auditor familiarity.
 *
 *         Modernizations applied (no logic changes):
 *         - 0.6.12 → 0.8.26; SafeMath dropped (built-in overflow).
 *         - `require` strings → custom errors.
 *         - Tomb's anonymous BoardroomSnapshot type stays the same shape.
 *
 *         Lockup defaults preserved from Tomb:
 *         - withdrawLockupEpochs = 6 (36h at 6h epochs)
 *         - rewardLockupEpochs   = 3 (18h)
 */
contract Boardroom is ShareWrapper, ContractGuard {
    using SafeERC20 for IERC20;

    /* ========== DATA STRUCTURES ========== */

    struct Memberseat {
        uint256 lastSnapshotIndex;
        uint256 rewardEarned;
        uint256 epochTimerStart;
    }

    struct BoardroomSnapshot {
        uint256 time;
        uint256 rewardReceived;
        uint256 rewardPerShare;
    }

    /* ========== STATE VARIABLES ========== */

    /// @notice The contract authorized for setOperator / setLockUp / allocateSeigniorage /
    ///         governanceRecoverUnsupported. Set to Treasury post-initialize.
    address public operator;

    bool public initialized;

    /// @notice $MONEY — the reward token paid out from snapshots.
    IERC20 public money;

    /// @notice Treasury that supplies seigniorage and epoch info.
    ITreasury public treasury;

    mapping(address => Memberseat) public members;
    BoardroomSnapshot[] public boardroomHistory;

    uint256 public withdrawLockupEpochs;
    uint256 public rewardLockupEpochs;

    /* ========== EVENTS ========== */

    event Initialized(address indexed executor, uint256 at);
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    event RewardAdded(address indexed user, uint256 reward);

    /* ========== ERRORS ========== */

    error NotOperator();
    error AlreadyInitialized();
    error MemberDoesNotExist();
    error CannotStakeZero();
    error CannotWithdrawZero();
    error InWithdrawLockup();
    error CannotAllocateZero();
    error CannotAllocateWhenTotalSupplyZero();
    error LockupOutOfRange();
    error ProtectedToken();

    /* ========== MODIFIERS ========== */

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier memberExists() {
        if (balanceOf(msg.sender) == 0) revert MemberDoesNotExist();
        _;
    }

    modifier updateReward(
        address member
    ) {
        if (member != address(0)) {
            Memberseat memory seat = members[member];
            seat.rewardEarned = earned(member);
            seat.lastSnapshotIndex = latestSnapshotIndex();
            members[member] = seat;
        }
        _;
    }

    modifier notInitialized() {
        if (initialized) revert AlreadyInitialized();
        _;
    }

    /* ========== GOVERNANCE ========== */

    function initialize(
        IERC20 _money,
        IERC20 _share,
        ITreasury _treasury
    ) public notInitialized {
        money = _money;
        share = _share;
        treasury = _treasury;

        boardroomHistory.push(BoardroomSnapshot({time: block.number, rewardReceived: 0, rewardPerShare: 0}));

        withdrawLockupEpochs = 6;
        rewardLockupEpochs = 3;

        initialized = true;
        operator = msg.sender;
        emit Initialized(msg.sender, block.number);
    }

    function setOperator(
        address newOperator
    ) external onlyOperator {
        operator = newOperator;
    }

    /// @notice Update the lockup epoch counts. `withdrawLockupEpochs >= rewardLockupEpochs`
    ///         and `withdrawLockupEpochs <= 56` (== 2 weeks at 6h epochs) — Tomb bounds.
    function setLockUp(
        uint256 _withdrawLockupEpochs,
        uint256 _rewardLockupEpochs
    ) external onlyOperator {
        if (_withdrawLockupEpochs < _rewardLockupEpochs || _withdrawLockupEpochs > 56) revert LockupOutOfRange();
        withdrawLockupEpochs = _withdrawLockupEpochs;
        rewardLockupEpochs = _rewardLockupEpochs;
    }

    /* ========== VIEW FUNCTIONS ========== */

    function latestSnapshotIndex() public view returns (uint256) {
        return boardroomHistory.length - 1;
    }

    function getLatestSnapshot() internal view returns (BoardroomSnapshot memory) {
        return boardroomHistory[latestSnapshotIndex()];
    }

    function getLastSnapshotIndexOf(
        address member
    ) public view returns (uint256) {
        return members[member].lastSnapshotIndex;
    }

    function getLastSnapshotOf(
        address member
    ) internal view returns (BoardroomSnapshot memory) {
        return boardroomHistory[getLastSnapshotIndexOf(member)];
    }

    function canWithdraw(
        address member
    ) external view returns (bool) {
        return members[member].epochTimerStart + withdrawLockupEpochs <= treasury.epoch();
    }

    function canClaimReward(
        address member
    ) external view returns (bool) {
        return members[member].epochTimerStart + rewardLockupEpochs <= treasury.epoch();
    }

    function epoch() external view returns (uint256) {
        return treasury.epoch();
    }

    function nextEpochPoint() external view returns (uint256) {
        return treasury.nextEpochPoint();
    }

    function getMoneyPrice() external view returns (uint256) {
        return treasury.getMoneyPrice();
    }

    function rewardPerShare() public view returns (uint256) {
        return getLatestSnapshot().rewardPerShare;
    }

    function earned(
        address member
    ) public view returns (uint256) {
        uint256 latestRPS = getLatestSnapshot().rewardPerShare;
        uint256 storedRPS = getLastSnapshotOf(member).rewardPerShare;
        return balanceOf(member) * (latestRPS - storedRPS) / 1e18 + members[member].rewardEarned;
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function stake(
        uint256 amount
    ) public override onlyOneBlock updateReward(msg.sender) {
        if (amount == 0) revert CannotStakeZero();
        super.stake(amount);
        members[msg.sender].epochTimerStart = treasury.epoch();
        emit Staked(msg.sender, amount);
    }

    function withdraw(
        uint256 amount
    ) public override onlyOneBlock memberExists updateReward(msg.sender) {
        if (amount == 0) revert CannotWithdrawZero();
        if (members[msg.sender].epochTimerStart + withdrawLockupEpochs > treasury.epoch()) {
            revert InWithdrawLockup();
        }
        claimReward();
        super.withdraw(amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Withdraw entire stake (and claim any due reward in the same call).
    function exit() external {
        withdraw(balanceOf(msg.sender));
    }

    /// @notice Claim accumulated $MONEY reward if past the reward lockup. Tomb-faithful:
    ///         silent no-op if reward is 0; reverts only if reward > 0 AND still in lockup.
    function claimReward() public updateReward(msg.sender) {
        uint256 reward = members[msg.sender].rewardEarned;
        if (reward > 0) {
            require(
                members[msg.sender].epochTimerStart + rewardLockupEpochs <= treasury.epoch(),
                "Boardroom: still in reward lockup"
            );
            members[msg.sender].epochTimerStart = treasury.epoch();
            members[msg.sender].rewardEarned = 0;
            money.safeTransfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
    }

    /// @notice Called by Treasury once per expansion epoch to deposit seigniorage and
    ///         snapshot a new reward-per-share.
    /// @dev Caller must have approved this amount of $MONEY to be pulled.
    function allocateSeigniorage(
        uint256 amount
    ) external onlyOneBlock onlyOperator {
        if (amount == 0) revert CannotAllocateZero();
        if (totalSupply() == 0) revert CannotAllocateWhenTotalSupplyZero();

        uint256 prevRPS = getLatestSnapshot().rewardPerShare;
        uint256 nextRPS = prevRPS + (amount * 1e18 / totalSupply());

        boardroomHistory.push(BoardroomSnapshot({time: block.number, rewardReceived: amount, rewardPerShare: nextRPS}));

        money.safeTransferFrom(msg.sender, address(this), amount);
        emit RewardAdded(msg.sender, amount);
    }

    /// @notice Rescue tokens mistakenly sent to this contract. Core tokens (money, share=estate)
    ///         are protected.
    function governanceRecoverUnsupported(
        IERC20 token,
        uint256 amount,
        address to
    ) external onlyOperator {
        if (address(token) == address(money)) revert ProtectedToken();
        if (address(token) == address(share)) revert ProtectedToken();
        token.safeTransfer(to, amount);
    }
}
