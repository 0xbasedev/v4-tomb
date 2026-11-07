// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IMasonrySeigniorageSink} from "./IMasonryRuntime.sol";

/// @notice Masonry stake room: holders of the configured stake token
/// (product: X Share/WETH LP) earn expansion X Tomb.
contract MasonryChamber is IMasonrySeigniorageSink, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable stakeToken;
    IERC20 public immutable rewardToken;
    address public immutable treasury;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    uint256 public accRewardPerShare;
    mapping(address => uint256) public rewardDebt;

    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 amount);
    event SeigniorageAllocated(uint256 amount);

    error ZeroAddress();
    error InvalidAmount();
    error Unauthorized();
    error EmptyMasonry();

    constructor(
        IERC20 stakeToken_,
        IERC20 rewardToken_,
        address treasury_
    ) {
        if (address(stakeToken_) == address(0) || address(rewardToken_) == address(0) || treasury_ == address(0)) {
            revert ZeroAddress();
        }
        stakeToken = stakeToken_;
        rewardToken = rewardToken_;
        treasury = treasury_;
    }

    function pending(
        address user
    ) public view returns (uint256) {
        return balanceOf[user] * accRewardPerShare / 1e18 - rewardDebt[user];
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

    function stake(
        uint256 amount
    ) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        _harvest(msg.sender);
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        totalSupply += amount;
        balanceOf[msg.sender] += amount;
        rewardDebt[msg.sender] = balanceOf[msg.sender] * accRewardPerShare / 1e18;
        emit Staked(msg.sender, amount);
    }

    function withdraw(
        uint256 amount
    ) external nonReentrant {
        if (amount == 0 || amount > balanceOf[msg.sender]) revert InvalidAmount();
        _harvest(msg.sender);
        totalSupply -= amount;
        balanceOf[msg.sender] -= amount;
        rewardDebt[msg.sender] = balanceOf[msg.sender] * accRewardPerShare / 1e18;
        stakeToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function claim() external nonReentrant {
        _harvest(msg.sender);
        rewardDebt[msg.sender] = balanceOf[msg.sender] * accRewardPerShare / 1e18;
    }

    function _harvest(
        address user
    ) internal {
        uint256 amount = pending(user);
        if (amount == 0) return;
        rewardDebt[user] = balanceOf[user] * accRewardPerShare / 1e18;
        rewardToken.safeTransfer(user, amount);
        emit RewardPaid(user, amount);
    }
}
