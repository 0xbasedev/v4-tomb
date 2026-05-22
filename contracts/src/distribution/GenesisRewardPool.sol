// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title GenesisRewardPool
 * @notice 24-hour MasterChef-style farm. The Treasury sends 11,000 MONEY here as part of
 *         the genesis `distributeReward(...)` call. LPs stake their (WETH/MONEY,
 *         USDC/WETH, etc.) LP tokens here and earn MONEY pro-rata over the 24-hour
 *         window. After the window closes, withdrawals continue and stakes can leave.
 *
 * @dev    Direct port of Tomb Finance's BombGenesisRewardPool (bombmoney/bomb-contracts).
 *
 *         Modernizations applied (no logic changes):
 *           - 0.6.12 → 0.8.26; SafeMath dropped (built-in overflow checks).
 *           - `require` strings → custom errors.
 *           - Variable renames: bomb → money, accBombPerShare → accMoneyPerShare, etc.
 *
 *         Intentional deviation from Tomb (justified):
 *           - The BSC-specific `cake` field (a PancakeSwap LP token that incurred a 1%
 *             deposit fee) is dropped. We're on Base; no such token exists. If a similar
 *             fee-on-transfer LP needs special handling later, it can be added per-pool.
 *
 *         Mechanism:
 *           - Pre-fund with 11,000 MONEY via `MONEY.distributeReward(genesisPool, ...)`.
 *           - Operator calls `add(allocPoint, lpToken, ...)` for each LP token to support.
 *           - LPs `deposit(pid, amount)` their LP tokens, earn MONEY pro-rata.
 *           - Rewards accrue at `MONEY_PER_SECOND` for `RUNNING_TIME` seconds (24h).
 *           - LPs can `withdraw(pid, amount)` or `emergencyWithdraw(pid)` anytime.
 *           - After `poolEndTime + 90 days`, operator can rescue any stuck tokens including
 *             unclaimed MONEY (rounding dust).
 */
contract GenesisRewardPool {
    using SafeERC20 for IERC20;

    struct UserInfo {
        uint256 amount; // LP tokens staked.
        uint256 rewardDebt; // MasterChef accounting term — see `pendingMoney`.
    }

    struct PoolInfo {
        IERC20 token; // The LP token contract for this pool entry.
        uint256 allocPoint; // Pool's share of `MONEY_PER_SECOND`, weighted by `totalAllocPoint`.
        uint256 lastRewardTime; // Last timestamp where rewards were folded into `accMoneyPerShare`.
        uint256 accMoneyPerShare; // 1e18-scaled accumulator.
        bool isStarted; // Pool's allocPoint has been added to `totalAllocPoint`.
    }

    /// @notice Total MONEY to distribute over the 24-hour window. The Treasury pre-funds
    ///         this contract with exactly `TOTAL_REWARDS` MONEY via `distributeReward`.
    uint256 public constant TOTAL_REWARDS = 11_000 ether;

    /// @notice Duration of the genesis distribution.
    uint256 public constant RUNNING_TIME = 1 days;

    /// @notice MONEY emitted per second across all pools (split by allocPoints).
    ///         = TOTAL_REWARDS / RUNNING_TIME = 11000e18 / 86400 ≈ 0.1273e18.
    uint256 public constant MONEY_PER_SECOND = TOTAL_REWARDS / RUNNING_TIME;

    IERC20 public immutable money;
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
        address _money,
        uint256 _poolStartTime
    ) {
        if (block.timestamp >= _poolStartTime) revert StartTimeInPast();
        money = IERC20(_money);
        poolStartTime = _poolStartTime;
        poolEndTime = _poolStartTime + RUNNING_TIME;
        operator = msg.sender;
        emit OperatorTransferred(address(0), msg.sender);
    }

    // ------------------------------------------------------------------
    // Pool management (operator-only)
    // ------------------------------------------------------------------

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

    // ------------------------------------------------------------------
    // Reward accounting
    // ------------------------------------------------------------------

    /// @notice Cumulative MONEY emitted over [_fromTime, _toTime], capped at the
    ///         start/end of the 24-hour window.
    function getGeneratedReward(
        uint256 _fromTime,
        uint256 _toTime
    ) public view returns (uint256) {
        if (_fromTime >= _toTime) return 0;
        if (_toTime >= poolEndTime) {
            if (_fromTime >= poolEndTime) return 0;
            if (_fromTime <= poolStartTime) {
                return (poolEndTime - poolStartTime) * MONEY_PER_SECOND;
            }
            return (poolEndTime - _fromTime) * MONEY_PER_SECOND;
        }
        if (_toTime <= poolStartTime) return 0;
        if (_fromTime <= poolStartTime) {
            return (_toTime - poolStartTime) * MONEY_PER_SECOND;
        }
        return (_toTime - _fromTime) * MONEY_PER_SECOND;
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

    // ------------------------------------------------------------------
    // User actions
    // ------------------------------------------------------------------

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

    /// @notice Withdraw without claiming pending rewards. Last-resort escape hatch.
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

    // ------------------------------------------------------------------
    // Stuck-token rescue (operator)
    // ------------------------------------------------------------------

    function governanceRecoverUnsupported(
        IERC20 _token,
        uint256 amount,
        address to
    ) external onlyOperator {
        if (block.timestamp < poolEndTime + 90 days) {
            // Within 90 days of pool end: protect MONEY + every staked LP token.
            if (_token == money) revert ProtectedToken();
            uint256 len = poolInfo.length;
            for (uint256 pid = 0; pid < len; ++pid) {
                if (poolInfo[pid].token == _token) revert ProtectedToken();
            }
        }
        _token.safeTransfer(to, amount);
    }

    // ------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------

    /// @dev Defensive transfer — if rounding causes a slight over-request, send what we have.
    function _safeMoneyTransfer(
        address to,
        uint256 amount
    ) internal {
        uint256 bal = money.balanceOf(address(this));
        if (bal == 0) return;
        money.safeTransfer(to, amount > bal ? bal : amount);
    }
}
