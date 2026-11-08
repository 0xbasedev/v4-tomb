// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Linear X Share farm. The first pool is the X Share/WETH LP.
/// `rewardBudget` and `duration` are PLACEHOLDER launch-config values
/// (`square.farming` whole tokens and `policy.farmEmissionDays`) until Jesse
/// signs off on tokenomics.
contract MasonryFarm is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Pool {
        IERC20 stakeToken;
        uint256 allocPoints;
        uint256 totalStaked;
        uint256 accRewardPerShare;
        uint256 lastRewardTime;
    }

    struct Policy {
        bool claimToWallet;
        uint256 withdrawCooldown;
        address daoWallet;
        address masonry;
        address zapper;
        uint16 withdrawFeeBps;
    }

    struct WithdrawRequest {
        uint256 amount;
        uint256 availableAt;
    }

    IERC20 public immutable share;
    uint256 public immutable startTime;
    uint256 public immutable duration;
    uint256 public immutable rewardBudget;
    address public immutable admin;
    bool public immutable claimToWallet;
    uint256 public immutable withdrawCooldown;
    address public immutable daoWallet;
    address public immutable masonry;
    address public immutable zapper;
    uint16 public constant MAX_WITHDRAW_FEE_BPS = 1_000;
    uint16 public withdrawFeeBps;

    uint256 public funded;
    uint256 public emitted;
    uint256 public claimed;
    uint256 public totalAllocPoints;
    Pool[] public pools;

    mapping(uint256 => mapping(address => uint256)) public userStake;
    mapping(uint256 => mapping(address => uint256)) public userRewardDebt;
    mapping(uint256 => mapping(address => uint256)) public storedReward;
    mapping(uint256 => mapping(address => WithdrawRequest)) public withdrawRequests;

    event Funded(address indexed from, uint256 amount);
    event PoolAdded(uint256 indexed pid, address stakeToken, uint256 allocPoints);
    event Deposited(address indexed user, uint256 indexed pid, uint256 amount);
    event Withdrawn(address indexed user, uint256 indexed pid, uint256 amount);
    event Harvested(address indexed user, uint256 indexed pid, uint256 amount);
    event ZappedIntoMasonry(address indexed user, uint256 indexed pid, uint256 shareIn, uint256 lpStaked, uint256 shareDust);
    event RewardsForfeited(address indexed user, uint256 indexed pid, uint256 amount, address indexed daoWallet);
    event WithdrawRequested(address indexed user, uint256 indexed pid, uint256 amount, uint256 availableAt);
    event WithdrawCompleted(address indexed user, uint256 indexed pid, uint256 amount, uint256 forfeited);
    event WithdrawCancelled(address indexed user, uint256 indexed pid, uint256 amount);
    event WithdrawFeePaid(address indexed user, uint256 indexed pid, uint256 fee, address indexed daoWallet);
    event WithdrawFeeUpdated(uint16 bps);

    error ZeroAddress();
    error InvalidConfiguration();
    error Unauthorized();
    error InvalidAmount();
    error OverFunded();
    error UnknownPool();
    error ClaimToWalletDisabled();
    error WithdrawPending();
    error WithdrawNotPending();
    error WithdrawCooldownActive();
    error UnsafeZap();
    error SlippageExceeded();

    constructor(
        IERC20 share_,
        uint256 startTime_,
        uint256 duration_,
        uint256 rewardBudget_,
        address admin_,
        IERC20 shareWethLp,
        uint256 shareWethLpAllocPoints,
        Policy memory policy
    ) {
        if (address(share_) == address(0) || admin_ == address(0) || address(shareWethLp) == address(0)) {
            revert ZeroAddress();
        }
        if (startTime_ == 0 || duration_ == 0 || rewardBudget_ == 0 || shareWethLpAllocPoints == 0) {
            revert InvalidConfiguration();
        }
        if (policy.daoWallet == address(0)) revert ZeroAddress();
        if (policy.withdrawCooldown < 60 || policy.withdrawCooldown > 1 days) revert InvalidConfiguration();
        if (!policy.claimToWallet && (policy.masonry == address(0) || policy.zapper == address(0))) {
            revert InvalidConfiguration();
        }
        share = share_;
        startTime = startTime_;
        duration = duration_;
        rewardBudget = rewardBudget_;
        admin = admin_;
        claimToWallet = policy.claimToWallet;
        withdrawCooldown = policy.withdrawCooldown;
        daoWallet = policy.daoWallet;
        masonry = policy.masonry;
        if (policy.withdrawFeeBps > MAX_WITHDRAW_FEE_BPS) revert InvalidConfiguration();
        zapper = policy.zapper;
        withdrawFeeBps = policy.withdrawFeeBps;
        _addPool(shareWethLp, shareWethLpAllocPoints);
    }

    function poolLength() external view returns (uint256) {
        return pools.length;
    }

    function entitledTo(
        uint256 timestamp
    ) public view returns (uint256) {
        if (timestamp <= startTime) return 0;
        uint256 end = startTime + duration;
        uint256 t = timestamp < end ? timestamp : end;
        return rewardBudget * (t - startTime) / duration;
    }

    function pending(
        uint256 pid,
        address user
    ) public view returns (uint256) {
        if (pid >= pools.length) revert UnknownPool();
        Pool memory pool = pools[pid];
        uint256 acc = pool.accRewardPerShare;
        if (pool.totalStaked > 0 && _clock() > pool.lastRewardTime) {
            uint256 activeAlloc;
            for (uint256 i; i < pools.length; ++i) {
                if (pools[i].totalStaked > 0) activeAlloc += pools[i].allocPoints;
            }
            if (activeAlloc > 0) {
                uint256 newly = _issuable(emitted);
                uint256 shareOfPool = newly * pool.allocPoints / activeAlloc;
                acc += shareOfPool * 1e18 / pool.totalStaked;
            }
        }
        return storedReward[pid][user] + userStake[pid][user] * acc / 1e18 - userRewardDebt[pid][user];
    }

    function fund(
        uint256 amount
    ) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (funded + amount > rewardBudget) revert OverFunded();
        share.safeTransferFrom(msg.sender, address(this), amount);
        funded += amount;
        emit Funded(msg.sender, amount);
    }

    function addPool(
        IERC20 stakeToken,
        uint256 allocPoints
    ) external nonReentrant {
        if (msg.sender != admin) revert Unauthorized();
        if (address(stakeToken) == address(0) || allocPoints == 0) revert InvalidConfiguration();
        _updateAll();
        _addPool(stakeToken, allocPoints);
    }

    function deposit(
        uint256 pid,
        uint256 amount
    ) external nonReentrant {
        if (pid >= pools.length) revert UnknownPool();
        if (amount == 0) revert InvalidAmount();
        _updateAll();
        _settle(pid, msg.sender);
        pools[pid].stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        pools[pid].totalStaked += amount;
        userStake[pid][msg.sender] += amount;
        userRewardDebt[pid][msg.sender] = userStake[pid][msg.sender] * pools[pid].accRewardPerShare / 1e18;
        emit Deposited(msg.sender, pid, amount);
    }

    function update() external {
        _updateAll();
    }

    function requestWithdraw(uint256 pid, uint256 amount) external nonReentrant {
        if (pid >= pools.length) revert UnknownPool();
        if (amount == 0 || amount > userStake[pid][msg.sender]) revert InvalidAmount();
        if (withdrawRequests[pid][msg.sender].amount != 0) revert WithdrawPending();
        _updateAll();
        _settle(pid, msg.sender);
        withdrawRequests[pid][msg.sender] =
            WithdrawRequest({amount: amount, availableAt: block.timestamp + withdrawCooldown});
        emit WithdrawRequested(msg.sender, pid, amount, block.timestamp + withdrawCooldown);
    }

    function completeWithdraw(uint256 pid) external nonReentrant {
        if (pid >= pools.length) revert UnknownPool();
        WithdrawRequest memory req = withdrawRequests[pid][msg.sender];
        if (req.amount == 0) revert WithdrawNotPending();
        if (block.timestamp < req.availableAt) revert WithdrawCooldownActive();
        delete withdrawRequests[pid][msg.sender];
        _updateAll();
        uint256 forfeited = _takeRewards(pid, msg.sender);
        if (forfeited != 0) {
            claimed += forfeited;
            share.safeTransfer(daoWallet, forfeited);
            emit RewardsForfeited(msg.sender, pid, forfeited, daoWallet);
        }
        pools[pid].totalStaked -= req.amount;
        userStake[pid][msg.sender] -= req.amount;
        userRewardDebt[pid][msg.sender] = userStake[pid][msg.sender] * pools[pid].accRewardPerShare / 1e18;
        uint256 fee = req.amount * uint256(withdrawFeeBps) / 10_000;
        uint256 net = req.amount - fee;
        if (fee != 0) {
            pools[pid].stakeToken.safeTransfer(daoWallet, fee);
            emit WithdrawFeePaid(msg.sender, pid, fee, daoWallet);
        }
        if (net != 0) pools[pid].stakeToken.safeTransfer(msg.sender, net);
        emit WithdrawCompleted(msg.sender, pid, req.amount, forfeited);
        emit Withdrawn(msg.sender, pid, req.amount);
    }

    function setWithdrawFeeBps(uint16 bps) external {
        if (msg.sender != admin) revert Unauthorized();
        if (bps > MAX_WITHDRAW_FEE_BPS) revert InvalidConfiguration();
        withdrawFeeBps = bps;
        emit WithdrawFeeUpdated(bps);
    }

    function cancelWithdraw(uint256 pid) external nonReentrant {
        WithdrawRequest memory req = withdrawRequests[pid][msg.sender];
        if (req.amount == 0) revert WithdrawNotPending();
        delete withdrawRequests[pid][msg.sender];
        emit WithdrawCancelled(msg.sender, pid, req.amount);
    }

    /// @notice Cancels a pending liquidity withdrawal and zaps pending X Share into Masonry.
    function compound(uint256 pid, uint256 minWethOut, uint256 minLpOut) external nonReentrant {
        if (withdrawRequests[pid][msg.sender].amount != 0) {
            uint256 amount = withdrawRequests[pid][msg.sender].amount;
            delete withdrawRequests[pid][msg.sender];
            emit WithdrawCancelled(msg.sender, pid, amount);
        }
        _zap(pid, msg.sender, minWethOut, minLpOut);
    }

    function harvest(uint256 pid) external nonReentrant {
        if (!claimToWallet) revert ClaimToWalletDisabled();
        if (pid >= pools.length) revert UnknownPool();
        _updateAll();
        uint256 amount = _takeRewards(pid, msg.sender);
        if (amount == 0) return;
        claimed += amount;
        share.safeTransfer(msg.sender, amount);
        emit Harvested(msg.sender, pid, amount);
    }

    function zapIntoMasonry(uint256 pid, uint256 minWethOut, uint256 minLpOut) external nonReentrant {
        _zap(pid, msg.sender, minWethOut, minLpOut);
    }

    function cooldownRemaining(uint256 pid, address user) external view returns (uint256) {
        WithdrawRequest memory req = withdrawRequests[pid][user];
        if (req.amount == 0 || block.timestamp >= req.availableAt) return 0;
        return req.availableAt - block.timestamp;
    }

    function _addPool(
        IERC20 stakeToken,
        uint256 allocPoints
    ) internal {
        pools.push(
            Pool({
                stakeToken: stakeToken,
                allocPoints: allocPoints,
                totalStaked: 0,
                accRewardPerShare: 0,
                lastRewardTime: _clock()
            })
        );
        totalAllocPoints += allocPoints;
        emit PoolAdded(pools.length - 1, address(stakeToken), allocPoints);
    }

    function _clock() internal view returns (uint256) {
        if (block.timestamp < startTime) return startTime;
        uint256 end = startTime + duration;
        return block.timestamp < end ? block.timestamp : end;
    }

    function _issuable(
        uint256 alreadyEmitted
    ) internal view returns (uint256) {
        uint256 entitled = entitledTo(block.timestamp);
        if (entitled <= alreadyEmitted) return 0;
        uint256 newly = entitled - alreadyEmitted;
        uint256 reserved = alreadyEmitted - claimed;
        uint256 balance = share.balanceOf(address(this));
        uint256 free = balance > reserved ? balance - reserved : 0;
        return newly < free ? newly : free;
    }

    function _updateAll() internal {
        uint256 newly = _issuable(emitted);
        uint256 activeAlloc;
        uint256 n = pools.length;
        for (uint256 i; i < n; ++i) {
            if (pools[i].totalStaked > 0) activeAlloc += pools[i].allocPoints;
        }
        if (activeAlloc == 0) {
            // Advance the schedule without paying later stakers for empty periods.
            uint256 entitled = entitledTo(block.timestamp);
            if (entitled > emitted) emitted = entitled;
            for (uint256 i; i < n; ++i) {
                pools[i].lastRewardTime = _clock();
            }
            return;
        }
        uint256 assigned;
        for (uint256 i; i < n; ++i) {
            Pool storage pool = pools[i];
            if (pool.totalStaked > 0 && newly > 0) {
                uint256 part = newly * pool.allocPoints / activeAlloc;
                pool.accRewardPerShare += part * 1e18 / pool.totalStaked;
                assigned += part;
            }
            pool.lastRewardTime = _clock();
        }
        emitted += assigned;
    }

    function _settle(uint256 pid, address user) internal {
        uint256 unpaid = userStake[pid][user] * pools[pid].accRewardPerShare / 1e18 - userRewardDebt[pid][user];
        if (unpaid != 0) storedReward[pid][user] += unpaid;
        userRewardDebt[pid][user] = userStake[pid][user] * pools[pid].accRewardPerShare / 1e18;
    }

    function _takeRewards(uint256 pid, address user) internal returns (uint256 amount) {
        _settle(pid, user);
        amount = storedReward[pid][user];
        storedReward[pid][user] = 0;
    }

    function _zap(uint256 pid, address user, uint256 minWethOut, uint256 minLpOut) internal {
        if (pid >= pools.length) revert UnknownPool();
        if (zapper == address(0) || masonry == address(0)) revert InvalidConfiguration();
        _updateAll();
        uint256 amount = _takeRewards(pid, user);
        if (amount < 2) revert InvalidAmount();
        claimed += amount;
        share.safeTransfer(zapper, amount);
        (uint256 lpOut, uint256 shareDust,) =
            IMasonryShareZapper(zapper).zap(user, amount, minWethOut, minLpOut);
        if (shareDust != 0) {
            claimed -= shareDust;
            storedReward[pid][user] += shareDust;
        }
        IERC20 lp = IERC20(IMasonryShareZapper(zapper).lpToken());
        lp.forceApprove(masonry, lpOut);
        IMasonryChamberStake(masonry).stakeFor(user, lpOut);
        emit ZappedIntoMasonry(user, pid, amount - shareDust, lpOut, shareDust);
    }
}

interface IMasonryShareZapper {
    function zap(address user, uint256 shareAmount, uint256 minWethOut, uint256 minLpOut)
        external
        returns (uint256 lpOut, uint256 shareDust, uint256 wethDust);
    function lpToken() external view returns (address);
}

interface IMasonryChamberStake {
    function stakeFor(address user, uint256 amount) external;
}
