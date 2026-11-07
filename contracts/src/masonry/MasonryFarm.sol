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

    IERC20 public immutable share;
    uint256 public immutable startTime;
    uint256 public immutable duration;
    uint256 public immutable rewardBudget;
    address public immutable admin;

    uint256 public funded;
    uint256 public emitted;
    uint256 public claimed;
    uint256 public totalAllocPoints;
    Pool[] public pools;

    mapping(uint256 => mapping(address => uint256)) public userStake;
    mapping(uint256 => mapping(address => uint256)) public userRewardDebt;

    event Funded(address indexed from, uint256 amount);
    event PoolAdded(uint256 indexed pid, address stakeToken, uint256 allocPoints);
    event Deposited(address indexed user, uint256 indexed pid, uint256 amount);
    event Withdrawn(address indexed user, uint256 indexed pid, uint256 amount);
    event Harvested(address indexed user, uint256 indexed pid, uint256 amount);

    error ZeroAddress();
    error InvalidConfiguration();
    error Unauthorized();
    error InvalidAmount();
    error OverFunded();
    error UnknownPool();

    constructor(
        IERC20 share_,
        uint256 startTime_,
        uint256 duration_,
        uint256 rewardBudget_,
        address admin_,
        IERC20 shareWethLp,
        uint256 shareWethLpAllocPoints
    ) {
        if (address(share_) == address(0) || admin_ == address(0) || address(shareWethLp) == address(0)) {
            revert ZeroAddress();
        }
        if (startTime_ == 0 || duration_ == 0 || rewardBudget_ == 0 || shareWethLpAllocPoints == 0) {
            revert InvalidConfiguration();
        }
        share = share_;
        startTime = startTime_;
        duration = duration_;
        rewardBudget = rewardBudget_;
        admin = admin_;
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
        return userStake[pid][user] * acc / 1e18 - userRewardDebt[pid][user];
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
        _harvest(pid, msg.sender);
        pools[pid].stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        pools[pid].totalStaked += amount;
        userStake[pid][msg.sender] += amount;
        userRewardDebt[pid][msg.sender] = userStake[pid][msg.sender] * pools[pid].accRewardPerShare / 1e18;
        emit Deposited(msg.sender, pid, amount);
    }

    function withdraw(
        uint256 pid,
        uint256 amount
    ) external nonReentrant {
        if (pid >= pools.length) revert UnknownPool();
        if (amount == 0 || amount > userStake[pid][msg.sender]) revert InvalidAmount();
        _updateAll();
        _harvest(pid, msg.sender);
        pools[pid].totalStaked -= amount;
        userStake[pid][msg.sender] -= amount;
        userRewardDebt[pid][msg.sender] = userStake[pid][msg.sender] * pools[pid].accRewardPerShare / 1e18;
        pools[pid].stakeToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, pid, amount);
    }

    function harvest(
        uint256 pid
    ) external nonReentrant {
        if (pid >= pools.length) revert UnknownPool();
        _updateAll();
        _harvest(pid, msg.sender);
        userRewardDebt[pid][msg.sender] = userStake[pid][msg.sender] * pools[pid].accRewardPerShare / 1e18;
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

    function _harvest(
        uint256 pid,
        address user
    ) internal {
        uint256 amount = userStake[pid][user] * pools[pid].accRewardPerShare / 1e18 - userRewardDebt[pid][user];
        if (amount == 0) return;
        userRewardDebt[pid][user] = userStake[pid][user] * pools[pid].accRewardPerShare / 1e18;
        claimed += amount;
        share.safeTransfer(user, amount);
        emit Harvested(user, pid, amount);
    }
}
