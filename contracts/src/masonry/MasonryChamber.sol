// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IMasonrySeigniorageSink} from "./IMasonryRuntime.sol";
import {IMasonryFireTax} from "./IMasonryFireTax.sol";

/// @notice Masonry stake room: holders of the configured stake token
/// (product: X Share/WETH LP) earn expansion X Tomb.
///
/// Locks: a 6-hour stake cooldown and a 6-hour claim cooldown. Every
/// deposit — including farm "Send to Masonry" via stakeFor — resets both
/// clocks for that user only, as if it were a fresh deposit.
///
/// Exit Now bypasses both locks: 50% of the user's staked LP returns to
/// them, 50% is sent to the protocol treasury, and 100% of pending X Tomb
/// is forfeited to Arbitrage. Exit Now does not also charge the Fire Tax
/// withdraw fee (the 50% split is the exit penalty). Ordinary eligible
/// withdrawals charge the live Fire Tax rate on withdrawn LP to daoWallet.
/// This path does not redeem LP or sell X Tomb.
contract MasonryChamber is IMasonrySeigniorageSink, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant STAKE_COOLDOWN = 6 hours;
    uint256 public constant CLAIM_COOLDOWN = 6 hours;

    IERC20 public immutable stakeToken;
    IERC20 public immutable rewardToken;
    address public immutable treasury;
    address public immutable daoWallet;
    address public immutable arbitrage;
    uint16 public constant MAX_WITHDRAW_FEE_BPS = 1_200;
    IMasonryFireTax public immutable fireTax;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    uint256 public accRewardPerShare;
    mapping(address => uint256) public rewardDebt;
    mapping(address => uint256) public storedReward;
    mapping(address => uint256) public stakeUnlockAt;
    mapping(address => uint256) public claimUnlockAt;
    address public farm;

    event Staked(address indexed user, uint256 amount);
    event FarmBound(address indexed farm);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 amount);
    event SeigniorageAllocated(uint256 amount);
    event ExitNow(address indexed user, uint256 lpToUser, uint256 lpToTreasury, uint256 rewardsToArbitrage);
    event WithdrawFeePaid(address indexed user, uint256 fee, address indexed daoWallet);

    error ZeroAddress();
    error InvalidAmount();
    error Unauthorized();
    error EmptyMasonry();
    error StakeLocked();
    error ClaimLocked();
    error FarmAlreadyBound();
    error InvalidConfiguration();

    constructor(
        IERC20 stakeToken_,
        IERC20 rewardToken_,
        address treasury_,
        address daoWallet_,
        address arbitrage_,
        IMasonryFireTax fireTax_
    ) {
        if (
            address(stakeToken_) == address(0) || address(rewardToken_) == address(0) || treasury_ == address(0)
                || daoWallet_ == address(0) || arbitrage_ == address(0) || address(fireTax_) == address(0)
        ) revert ZeroAddress();
        stakeToken = stakeToken_;
        rewardToken = rewardToken_;
        treasury = treasury_;
        daoWallet = daoWallet_;
        arbitrage = arbitrage_;
        fireTax = fireTax_;
    }

    /// @notice Live Fire Tax rate (TWAP + recovery), hard-capped at 12%.
    function withdrawFeeBps() public view returns (uint16) {
        uint16 bps = fireTax.currentWithdrawFeeBps();
        if (bps > MAX_WITHDRAW_FEE_BPS) revert InvalidConfiguration();
        return bps;
    }

    function _chargeWithdrawFeeBps() internal returns (uint16) {
        fireTax.syncWithdrawFeeBps();
        return withdrawFeeBps();
    }

    function pending(
        address user
    ) public view returns (uint256) {
        return storedReward[user] + _unpaid(user);
    }

    function allocateSeigniorage(
        uint256 amount
    ) external nonReentrant {
        if (msg.sender != treasury) revert Unauthorized();
        if (totalSupply == 0) revert EmptyMasonry();
        if (amount == 0) revert InvalidAmount();
        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        accRewardPerShare += amount * 1e18 / totalSupply;
        emit SeigniorageAllocated(amount);
    }

    function bindFarm(address farm_) external {
        if (msg.sender != treasury) revert Unauthorized();
        if (farm_ == address(0)) revert ZeroAddress();
        if (farm != address(0)) revert FarmAlreadyBound();
        farm = farm_;
        emit FarmBound(farm_);
    }

    function stake(
        uint256 amount
    ) external nonReentrant {
        _stakeFor(msg.sender, amount, true);
    }

    /// @notice Credits LP to `user` and restarts Masonry aging (stake and claim
    /// cooldowns) for `user` only. Only the bound farm / Send-to-Masonry path
    /// may deposit on someone else's behalf.
    function stakeFor(address user, uint256 amount) external nonReentrant {
        if (msg.sender != farm) revert Unauthorized();
        if (user == address(0)) revert ZeroAddress();
        _stakeFor(user, amount, false);
    }

    function _stakeFor(address user, uint256 amount, bool pullFromUser) private {
        if (amount == 0) revert InvalidAmount();
        _accrue(user);
        stakeToken.safeTransferFrom(pullFromUser ? user : msg.sender, address(this), amount);
        totalSupply += amount;
        balanceOf[user] += amount;
        rewardDebt[user] = balanceOf[user] * accRewardPerShare / 1e18;
        stakeUnlockAt[user] = block.timestamp + STAKE_COOLDOWN;
        claimUnlockAt[user] = block.timestamp + CLAIM_COOLDOWN;
        emit Staked(user, amount);
    }

    function withdraw(
        uint256 amount
    ) external nonReentrant {
        if (amount == 0 || amount > balanceOf[msg.sender]) revert InvalidAmount();
        if (block.timestamp < stakeUnlockAt[msg.sender]) revert StakeLocked();
        _accrue(msg.sender);
        totalSupply -= amount;
        balanceOf[msg.sender] -= amount;
        rewardDebt[msg.sender] = balanceOf[msg.sender] * accRewardPerShare / 1e18;
        uint256 fee = amount * uint256(_chargeWithdrawFeeBps()) / 10_000;
        uint256 net = amount - fee;
        if (fee != 0) {
            stakeToken.safeTransfer(daoWallet, fee);
            emit WithdrawFeePaid(msg.sender, fee, daoWallet);
        }
        if (net != 0) stakeToken.safeTransfer(msg.sender, net);
        emit Withdrawn(msg.sender, amount);
    }

    function claim() external nonReentrant {
        if (block.timestamp < claimUnlockAt[msg.sender]) revert ClaimLocked();
        _accrue(msg.sender);
        uint256 amount = storedReward[msg.sender];
        if (amount == 0) return;
        storedReward[msg.sender] = 0;
        claimUnlockAt[msg.sender] = block.timestamp + CLAIM_COOLDOWN;
        rewardToken.safeTransfer(msg.sender, amount);
        emit RewardPaid(msg.sender, amount);
    }

    /// @notice Instant lock bypass. Does not redeem LP or sell X Tomb.
    /// Does not charge the ordinary Fire Tax withdraw fee.
    function exitNow() external nonReentrant {
        _accrue(msg.sender);
        uint256 staked = balanceOf[msg.sender];
        if (staked == 0) revert InvalidAmount();
        uint256 rewards = storedReward[msg.sender];
        storedReward[msg.sender] = 0;
        balanceOf[msg.sender] = 0;
        totalSupply -= staked;
        rewardDebt[msg.sender] = 0;

        uint256 toUser = staked / 2;
        uint256 toTreasury = staked - toUser;
        if (toUser > 0) stakeToken.safeTransfer(msg.sender, toUser);
        if (toTreasury > 0) stakeToken.safeTransfer(daoWallet, toTreasury);
        if (rewards > 0) rewardToken.safeTransfer(arbitrage, rewards);
        emit ExitNow(msg.sender, toUser, toTreasury, rewards);
    }

    function _unpaid(
        address user
    ) internal view returns (uint256) {
        return balanceOf[user] * accRewardPerShare / 1e18 - rewardDebt[user];
    }

    function _accrue(
        address user
    ) internal {
        storedReward[user] += _unpaid(user);
        rewardDebt[user] = balanceOf[user] * accRewardPerShare / 1e18;
    }
}
