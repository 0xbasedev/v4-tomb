// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MainRewardPool
 * @notice Multi-epoch MasterChef farm distributing the 140,000 MONEY main reward
 *         allocation across two epochs:
 *           - Epoch 0: 80,000 MONEY over 4 days (day 2-5)
 *           - Epoch 1: 60,000 MONEY over 5 days (day 6-10)
 *         Pool dies after epoch 1.
 *
 * @dev    Direct port of Tomb Finance's BombRewardPool. The two-epoch reward
 *         calculation is the only meaningful divergence from GenesisRewardPool.
 *         `getGeneratedReward` walks the epoch boundary correctly, returning the
 *         sum of (time-in-epoch-0 × rate0) + (time-in-epoch-1 × rate1) for any
 *         given [_fromTime, _toTime] interval.
 *
 *         Modernizations applied (no logic changes):
 *           - 0.6.12 → 0.8.26; SafeMath dropped.
 *           - `require` strings → custom errors.
 *           - BSC-specific `cake` LP-deposit-fee dropped.
 */
contract MainRewardPool {
    using SafeERC20 for IERC20;

    struct UserInfo {
        uint256 amount;
        uint256 rewardDebt;
    }

    struct PoolInfo {
        IERC20 token;
        uint256 allocPoint;
        uint256 lastRewardTime;
        uint256 accMoneyPerShare;
        bool isStarted;
    }

    /// @notice Total MONEY distributed across both epochs. The Treasury pre-funds this
    ///         contract with exactly TOTAL_REWARDS MONEY via `distributeReward`.
    uint256 public constant TOTAL_REWARDS = 140_000 ether;

    uint256 public constant EPOCH_0_REWARDS = 80_000 ether;
    uint256 public constant EPOCH_1_REWARDS = 60_000 ether;

    uint256 public constant EPOCH_0_DURATION = 4 days;
    uint256 public constant EPOCH_1_DURATION = 5 days;

    IERC20 public immutable money;
    address public operator;

    PoolInfo[] public poolInfo;
    mapping(uint256 => mapping(address => UserInfo)) public userInfo;

    uint256 public totalAllocPoint;

    uint256 public immutable poolStartTime;
    /// @notice 3-tuple of epoch end timestamps. Index 2 is sentinel zero.
    uint256[3] public epochEndTimes;
    /// @notice Per-second emission rate during each epoch. Index 2 is 0 (terminator).
    uint256[3] public epochMoneyPerSecond;

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
        address _money,
        uint256 _poolStartTime
    ) {
        if (block.timestamp >= _poolStartTime) revert StartTimeInPast();
        money = IERC20(_money);
        poolStartTime = _poolStartTime;
        epochEndTimes[0] = _poolStartTime + EPOCH_0_DURATION;
        epochEndTimes[1] = epochEndTimes[0] + EPOCH_1_DURATION;
        // epochEndTimes[2] remains 0 — sentinel.
        epochMoneyPerSecond[0] = EPOCH_0_REWARDS / EPOCH_0_DURATION;
        epochMoneyPerSecond[1] = EPOCH_1_REWARDS / EPOCH_1_DURATION;
        // epochMoneyPerSecond[2] remains 0 — terminator.
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
                accMoneyPerShare: 0,
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

    /// @notice Cumulative MONEY emitted over [_fromTime, _toTime] across both epochs.
    function getGeneratedReward(
        uint256 _fromTime,
        uint256 _toTime
    ) public view returns (uint256 reward) {
        if (_fromTime >= _toTime) return 0;
        // Clamp window into [poolStartTime, epochEndTimes[1]].
        if (_fromTime < poolStartTime) _fromTime = poolStartTime;
        if (_toTime > epochEndTimes[1]) _toTime = epochEndTimes[1];
        if (_fromTime >= _toTime) return 0;

        // Time in epoch 0.
        if (_fromTime < epochEndTimes[0]) {
            uint256 e0End = _toTime < epochEndTimes[0] ? _toTime : epochEndTimes[0];
            reward += (e0End - _fromTime) * epochMoneyPerSecond[0];
            _fromTime = e0End;
        }
        // Time in epoch 1.
        if (_fromTime < _toTime) {
            reward += (_toTime - _fromTime) * epochMoneyPerSecond[1];
        }
    }

    function pendingMoney(
        uint256 _pid,
        address _user
    ) external view returns (uint256) {
        PoolInfo storage pool = poolInfo[_pid];
        UserInfo storage user = userInfo[_pid][_user];
        uint256 accMoneyPerShare = pool.accMoneyPerShare;
        uint256 tokenSupply = pool.token.balanceOf(address(this));
        if (block.timestamp > pool.lastRewardTime && tokenSupply != 0 && totalAllocPoint > 0) {
            uint256 generated = getGeneratedReward(pool.lastRewardTime, block.timestamp);
            uint256 moneyReward = generated * pool.allocPoint / totalAllocPoint;
            accMoneyPerShare += moneyReward * 1e18 / tokenSupply;
        }
        return user.amount * accMoneyPerShare / 1e18 - user.rewardDebt;
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
            uint256 moneyReward = generated * pool.allocPoint / totalAllocPoint;
            pool.accMoneyPerShare += moneyReward * 1e18 / tokenSupply;
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
            uint256 pending = user.amount * pool.accMoneyPerShare / 1e18 - user.rewardDebt;
            if (pending > 0) {
                _safeMoneyTransfer(msg.sender, pending);
                emit RewardPaid(msg.sender, pending);
            }
        }
        if (_amount > 0) {
            pool.token.safeTransferFrom(msg.sender, address(this), _amount);
            user.amount += _amount;
        }
        user.rewardDebt = user.amount * pool.accMoneyPerShare / 1e18;
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
        uint256 pending = user.amount * pool.accMoneyPerShare / 1e18 - user.rewardDebt;
        if (pending > 0) {
            _safeMoneyTransfer(msg.sender, pending);
            emit RewardPaid(msg.sender, pending);
        }
        if (_amount > 0) {
            user.amount -= _amount;
            pool.token.safeTransfer(msg.sender, _amount);
        }
        user.rewardDebt = user.amount * pool.accMoneyPerShare / 1e18;
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
        if (block.timestamp < epochEndTimes[1] + 90 days) {
            if (_token == money) revert ProtectedToken();
            uint256 len = poolInfo.length;
            for (uint256 pid = 0; pid < len; ++pid) {
                if (poolInfo[pid].token == _token) revert ProtectedToken();
            }
        }
        _token.safeTransfer(to, amount);
    }

    function _safeMoneyTransfer(
        address to,
        uint256 amount
    ) internal {
        uint256 bal = money.balanceOf(address(this));
        if (bal == 0) return;
        money.safeTransfer(to, amount > bal ? bal : amount);
    }
}
