// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ShareRewardPool
 * @notice 370-day MasterChef-style farm for $ESTATE distribution. Estate's farming
 *         allocation (59,500 ESTATE from `Estate.distributeReward(farmingPool)`) is
 *         pre-funded into this contract; LPs stake their LP tokens and earn ESTATE
 *         pro-rata over the year.
 *
 * @dev    Direct port of Tomb Finance's BShareRewardPool. Same MasterChef machinery
 *         as GenesisRewardPool but with `share` (ESTATE) as the reward token, a longer
 *         RUNNING_TIME (370 days), and different TOTAL_REWARDS (59,500 ESTATE).
 *
 *         Modernizations applied (no logic changes):
 *           - 0.6.12 → 0.8.26; SafeMath dropped.
 *           - `require` strings → custom errors.
 *           - Renamed bsharePerSecond → sharePerSecond, etc.
 *
 *         No `cake` deposit-fee logic (BSC-specific, dropped — same reason as
 *         GenesisRewardPool).
 */
contract ShareRewardPool {
    using SafeERC20 for IERC20;

    struct UserInfo {
        uint256 amount;
        uint256 rewardDebt;
    }

    struct PoolInfo {
        IERC20 token;
        uint256 allocPoint;
        uint256 lastRewardTime;
        uint256 accSharePerShare;
        bool isStarted;
    }

    uint256 public constant TOTAL_REWARDS = 59_500 ether;
    uint256 public constant RUNNING_TIME = 370 days;
    uint256 public constant SHARE_PER_SECOND = TOTAL_REWARDS / RUNNING_TIME;

    IERC20 public immutable share;
    address public operator;

    PoolInfo[] public poolInfo;
    mapping(uint256 => mapping(address => UserInfo)) public userInfo;

    uint256 public totalAllocPoint;

    uint256 public immutable poolStartTime;
    uint256 public immutable poolEndTime;

    event Deposit(address indexed user, uint256 indexed pid, uint256 amount);
    event Withdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event EmergencyWithdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event RewardPaid(address indexed user, uint256 amount);
    event PoolAdded(uint256 indexed pid, IERC20 indexed token, uint256 allocPoint);
    event PoolUpdated(uint256 indexed pid, uint256 newAllocPoint);
    event OperatorTransferred(address indexed previous, address indexed next);

    error NotOperator();
    error StartTimeInPast();
    error PoolAlreadyExists();
    error WithdrawAmountTooHigh();
    error ProtectedToken();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(
        address _share,
        uint256 _poolStartTime
    ) {
        if (block.timestamp >= _poolStartTime) revert StartTimeInPast();
        share = IERC20(_share);
        poolStartTime = _poolStartTime;
        poolEndTime = _poolStartTime + RUNNING_TIME;
        operator = msg.sender;
        emit OperatorTransferred(address(0), msg.sender);
    }

    function checkPoolDuplicate(
        IERC20 _token
    ) internal view {
        uint256 len = poolInfo.length;
        for (uint256 pid = 0; pid < len; ++pid) {
            if (poolInfo[pid].token == _token) revert PoolAlreadyExists();
        }
    }

    function add(
        uint256 _allocPoint,
        IERC20 _token,
        bool _withUpdate,
        uint256 _lastRewardTime
    ) public onlyOperator {
        checkPoolDuplicate(_token);
        if (_withUpdate) massUpdatePools();

        if (block.timestamp < poolStartTime) {
            if (_lastRewardTime == 0 || _lastRewardTime < poolStartTime) {
                _lastRewardTime = poolStartTime;
            }
        } else {
            if (_lastRewardTime == 0 || _lastRewardTime < block.timestamp) {
                _lastRewardTime = block.timestamp;
            }
        }
        bool _isStarted = (_lastRewardTime <= poolStartTime) || (_lastRewardTime <= block.timestamp);
        poolInfo.push(
            PoolInfo({
                token: _token,
                allocPoint: _allocPoint,
                lastRewardTime: _lastRewardTime,
                accSharePerShare: 0,
                isStarted: _isStarted
            })
        );
        if (_isStarted) {
            totalAllocPoint += _allocPoint;
        }
        emit PoolAdded(poolInfo.length - 1, _token, _allocPoint);
    }

    function set(
        uint256 _pid,
        uint256 _allocPoint
    ) public onlyOperator {
        massUpdatePools();
        PoolInfo storage pool = poolInfo[_pid];
        if (pool.isStarted) {
            totalAllocPoint = totalAllocPoint - pool.allocPoint + _allocPoint;
        }
        pool.allocPoint = _allocPoint;
        emit PoolUpdated(_pid, _allocPoint);
    }

    function setOperator(
        address _operator
    ) external onlyOperator {
        emit OperatorTransferred(operator, _operator);
        operator = _operator;
    }

    function getGeneratedReward(
        uint256 _fromTime,
        uint256 _toTime
    ) public view returns (uint256) {
        if (_fromTime >= _toTime) return 0;
        if (_toTime >= poolEndTime) {
            if (_fromTime >= poolEndTime) return 0;
            if (_fromTime <= poolStartTime) {
                return (poolEndTime - poolStartTime) * SHARE_PER_SECOND;
            }
            return (poolEndTime - _fromTime) * SHARE_PER_SECOND;
        }
        if (_toTime <= poolStartTime) return 0;
        if (_fromTime <= poolStartTime) {
            return (_toTime - poolStartTime) * SHARE_PER_SECOND;
        }
        return (_toTime - _fromTime) * SHARE_PER_SECOND;
    }

    function pendingShare(
        uint256 _pid,
        address _user
    ) external view returns (uint256) {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][_user];
        uint256 accSharePerShare = pool.accSharePerShare;
        uint256 tokenSupply = pool.token.balanceOf(address(this));
        if (block.timestamp > pool.lastRewardTime && tokenSupply != 0 && totalAllocPoint > 0) {
            uint256 generated = getGeneratedReward(pool.lastRewardTime, block.timestamp);
            uint256 shareReward = generated * pool.allocPoint / totalAllocPoint;
            // slither-disable-next-line divide-before-multiply
            accSharePerShare += shareReward * 1e18 / tokenSupply;
        }
        return user.amount * accSharePerShare / 1e18 - user.rewardDebt;
    }

    function massUpdatePools() public {
        uint256 len = poolInfo.length;
        for (uint256 pid = 0; pid < len; ++pid) {
            updatePool(pid);
        }
    }

    function updatePool(
        uint256 _pid
    ) public {
        PoolInfo storage pool = poolInfo[_pid];
        if (block.timestamp <= pool.lastRewardTime) return;
        uint256 tokenSupply = pool.token.balanceOf(address(this));
        // slither-disable-next-line incorrect-equality — sentinel: skip update when no stakes
        if (tokenSupply == 0) {
            pool.lastRewardTime = block.timestamp;
            return;
        }
        if (!pool.isStarted) {
            pool.isStarted = true;
            totalAllocPoint += pool.allocPoint;
        }
        if (totalAllocPoint > 0) {
            uint256 generated = getGeneratedReward(pool.lastRewardTime, block.timestamp);
            uint256 shareReward = generated * pool.allocPoint / totalAllocPoint;
            // slither-disable-next-line divide-before-multiply
            pool.accSharePerShare += shareReward * 1e18 / tokenSupply;
        }
        pool.lastRewardTime = block.timestamp;
    }

    function deposit(
        uint256 _pid,
        uint256 _amount
    ) external {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];
        updatePool(_pid);
        if (user.amount > 0) {
            uint256 pending = user.amount * pool.accSharePerShare / 1e18 - user.rewardDebt;
            if (pending > 0) {
                _safeShareTransfer(msg.sender, pending);
                emit RewardPaid(msg.sender, pending);
            }
        }
        if (_amount > 0) {
            pool.token.safeTransferFrom(msg.sender, address(this), _amount);
            user.amount += _amount;
        }
        user.rewardDebt = user.amount * pool.accSharePerShare / 1e18;
        emit Deposit(msg.sender, _pid, _amount);
    }

    function withdraw(
        uint256 _pid,
        uint256 _amount
    ) external {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];
        if (user.amount < _amount) revert WithdrawAmountTooHigh();
        updatePool(_pid);
        uint256 pending = user.amount * pool.accSharePerShare / 1e18 - user.rewardDebt;
        if (pending > 0) {
            _safeShareTransfer(msg.sender, pending);
            emit RewardPaid(msg.sender, pending);
        }
        if (_amount > 0) {
            user.amount -= _amount;
            pool.token.safeTransfer(msg.sender, _amount);
        }
        user.rewardDebt = user.amount * pool.accSharePerShare / 1e18;
        emit Withdraw(msg.sender, _pid, _amount);
    }

    function emergencyWithdraw(
        uint256 _pid
    ) external {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][msg.sender];
        uint256 amount = user.amount;
        user.amount = 0;
        user.rewardDebt = 0;
        pool.token.safeTransfer(msg.sender, amount);
        emit EmergencyWithdraw(msg.sender, _pid, amount);
    }

    function governanceRecoverUnsupported(
        IERC20 _token,
        uint256 amount,
        address to
    ) external onlyOperator {
        if (block.timestamp < poolEndTime + 90 days) {
            if (_token == share) revert ProtectedToken();
            uint256 len = poolInfo.length;
            for (uint256 pid = 0; pid < len; ++pid) {
                if (poolInfo[pid].token == _token) revert ProtectedToken();
            }
        }
        _token.safeTransfer(to, amount);
    }

    function _safeShareTransfer(
        address to,
        uint256 amount
    ) internal {
        uint256 bal = share.balanceOf(address(this));
        // slither-disable-next-line incorrect-equality — sentinel: nothing to send
        if (bal == 0) return;
        share.safeTransfer(to, amount > bal ? bal : amount);
    }
}
