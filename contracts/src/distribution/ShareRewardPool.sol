// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title ShareRewardPool
 * @notice 370-day MasterChef-style farm for $ESTATE distribution. ShareToken's farming
 *         allocation (59,500 ESTATE from `ShareToken.distributeReward(farmingPool)`) is
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
 *
 *         Weekly loyalty boost (specs.md §8/§18, added 2026-11-09): when the
 *         operator enables `boostPercent`, that percent of farm emissions is
 *         carved out of the pool split (pools are weighted against
 *         totalAllocPoint + boostWeight, so with alloc points 75/20 and a 5%
 *         boost the emission divides exactly 75/20/5) and accrues into weekly
 *         buckets. A week's bucket is shared pro-rata by the stakers who held
 *         stake for the WHOLE week with zero LP withdrawals (the loyalty
 *         clock — the tree tracked no withdrawal signal, so the minimum
 *         tracking lives here: per-user stake total, start-of-week stake
 *         snapshot, dirty-week flag, and last-withdrawal timestamp,
 *         snapshotted settle-before-change on every deposit/withdraw).
 *         Entitlements settle lazily into a pull-based `claimBoost()`.
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

    // ---- Weekly loyalty boost (specs.md §8/§18) ----

    struct BoostInfo {
        uint256 stakeTotal; // LP staked across both farm pools (mirrored on every stake change)
        uint256 weekStartAmount; // stake in force at the start of `markWeek`
        uint256 markWeek; // week of the user's last stake-changing event
        bool marked; // whether a snapshot exists
        bool weekDirty; // an LP withdrawal landed during `markWeek`
        uint256 settledWeek; // weeks < settledWeek are settled into `credit`
        uint256 credit; // settled, claimable boost (xSHARE)
        uint256 lastWithdrawAt; // loyalty clock: last LP withdrawal time (0 = never)
    }

    /// @notice Percent of farm emissions routed to the weekly boost. 0 = off;
    ///         the launch config sets 5 (see config/masonry-weekly-boost.template.json).
    uint256 public boostPercent;
    /// @notice Length of one loyalty week in seconds (default 7 days).
    ///         Settable only before the farm starts, so boundaries never move.
    uint256 public weekLength;
    uint256 public boostLastSettle; // last timestamp boost accrual was sliced
    uint256 public totalBoostAccrued; // cumulative xSHARE earmarked for the boost
    uint256 public closedWeeks; // weeks [0, closedWeeks) are closed
    uint256 public openEligibleTotal; // eligible stake total for the currently open week
    mapping(uint256 => uint256) public weekBoost; // week => xSHARE accrued for that week
    mapping(uint256 => uint256) public weekEligibleTotal; // week => frozen eligible stake
    mapping(address => BoostInfo) public boostInfo;

    uint256 public immutable poolStartTime;
    uint256 public immutable poolEndTime;

    event Deposit(address indexed user, uint256 indexed pid, uint256 amount);
    event Withdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event EmergencyWithdraw(address indexed user, uint256 indexed pid, uint256 amount);
    event RewardPaid(address indexed user, uint256 amount);
    event PoolAdded(uint256 indexed pid, IERC20 indexed token, uint256 allocPoint);
    event PoolUpdated(uint256 indexed pid, uint256 newAllocPoint);
    event OperatorTransferred(address indexed previous, address indexed next);
    event BoostPercentSet(uint256 percent);
    event WeekLengthSet(uint256 secondsLength);
    event BoostWeekClosed(uint256 indexed week, uint256 eligibleTotal, uint256 boostAmount);
    event BoostClaimed(address indexed user, uint256 amount);

    error NotOperator();
    error StartTimeInPast();
    error PoolAlreadyExists();
    error WithdrawAmountTooHigh();
    error ProtectedToken();
    error InvalidBoostPercent();
    error InvalidWeekLength();
    error WeekLengthLocked();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(
        address _share,
        uint256 _poolStartTime,
        address initialOperator
    ) {
        if (block.timestamp >= _poolStartTime) revert StartTimeInPast();
        share = IERC20(_share);
        poolStartTime = _poolStartTime;
        poolEndTime = _poolStartTime + RUNNING_TIME;
        if (initialOperator == address(0)) revert NotOperator();
        operator = initialOperator;
        emit OperatorTransferred(address(0), initialOperator);
        // Weekly boost defaults: off until the operator applies the launch
        // config (5%); the week is 7 days unless set before the farm starts.
        boostPercent = 0;
        weekLength = 7 days;
        boostLastSettle = _poolStartTime;
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

    // ---- Weekly loyalty boost: admin ----

    /// @notice Set the percent of farm emissions routed to the weekly boost.
    ///         Accrual settles under the old percent before the new one applies.
    function setBoostPercent(
        uint256 _percent
    ) external onlyOperator {
        if (_percent > 25) revert InvalidBoostPercent();
        _settleBoost();
        boostPercent = _percent;
        emit BoostPercentSet(_percent);
    }

    /// @notice Set the loyalty week length. Only before the farm starts —
    ///         week boundaries must never move under stakers.
    function setWeekLength(
        uint256 _seconds
    ) external onlyOperator {
        if (block.timestamp >= poolStartTime) revert WeekLengthLocked();
        if (_seconds < 1 days || _seconds > 30 days) revert InvalidWeekLength();
        weekLength = _seconds;
        emit WeekLengthSet(_seconds);
    }

    // ---- Weekly loyalty boost: views ----

    function currentWeek() public view returns (uint256) {
        if (block.timestamp <= poolStartTime) return 0;
        return (block.timestamp - poolStartTime) / weekLength;
    }

    /// @notice The virtual alloc weight of the boost at the current percent:
    ///         with pool alloc points summing to 95 and a 5% boost this is 5,
    ///         so emissions divide exactly 75/20/5.
    function boostWeight() public view returns (uint256) {
        if (boostPercent == 0 || totalAllocPoint == 0) return 0;
        return totalAllocPoint * boostPercent / (100 - boostPercent);
    }

    /// @notice Loyalty clock (§7): the user's last LP withdrawal time (0 = never).
    function lastLpWithdrawalAt(
        address _user
    ) external view returns (uint256) {
        return boostInfo[_user].lastWithdrawAt;
    }

    /// @notice Boost the user could claim right now: settled credit plus the
    ///         entitlement from every already-closed week, computed read-only.
    function pendingBoost(
        address _user
    ) public view returns (uint256) {
        BoostInfo storage b = boostInfo[_user];
        uint256 total = b.credit;
        for (uint256 w = b.settledWeek; w < closedWeeks; ++w) {
            uint256 amt = _eligibleAmountFor(b, w);
            if (amt > 0 && weekEligibleTotal[w] > 0) {
                total += weekBoost[w] * amt / weekEligibleTotal[w];
            }
        }
        return total;
    }

    // ---- Weekly loyalty boost: claim ----

    /// @notice Settle all closed weeks and pay out the accumulated boost.
    ///         Pull-based: a user's entitlement can only be computed by
    ///         settling their weeks, so claiming is the settlement trigger
    ///         (stake changes settle credit too, but never force a payout).
    function claimBoost() external {
        _settleBoost();
        _settleUserBoost(msg.sender);
        BoostInfo storage b = boostInfo[msg.sender];
        uint256 amount = b.credit;
        if (amount == 0) return;
        b.credit = 0;
        _safeShareTransfer(msg.sender, amount);
        emit BoostClaimed(msg.sender, amount);
    }

    // ---- Weekly loyalty boost: internals ----

    function _weekIndex(
        uint256 _t
    ) internal view returns (uint256) {
        if (_t <= poolStartTime) return 0;
        return (_t - poolStartTime) / weekLength;
    }

    function _totalStakedAll() internal view returns (uint256) {
        uint256 total = 0;
        uint256 len = poolInfo.length;
        for (uint256 pid = 0; pid < len; ++pid) {
            total += poolInfo[pid].token.balanceOf(address(this));
        }
        return total;
    }

    /// @dev Slice the emissions stream since `boostLastSettle` into weekly
    ///      boost buckets at the current percent, then close every week that
    ///      has fully ended. Runs before any stake or weight mutation, so all
    ///      snapshots read pre-change state. A week that closes with zero
    ///      eligible stake rolls its whole bucket into the next week — the
    ///      boost is never lost and never locked.
    function _settleBoost() internal {
        uint256 nowTs = block.timestamp;
        if (nowTs > boostLastSettle) {
            if (boostPercent > 0 && totalAllocPoint > 0) {
                uint256 bw = boostWeight();
                uint256 denom = totalAllocPoint + bw;
                uint256 from = boostLastSettle;
                while (from < nowTs) {
                    uint256 w = _weekIndex(from);
                    uint256 wkEnd = poolStartTime + (w + 1) * weekLength;
                    uint256 segEnd = nowTs < wkEnd ? nowTs : wkEnd;
                    uint256 gen = getGeneratedReward(from, segEnd);
                    if (gen > 0) {
                        uint256 slice = gen * bw / denom;
                        weekBoost[w] += slice;
                        totalBoostAccrued += slice;
                    }
                    from = segEnd;
                }
            }
            boostLastSettle = nowTs;
        }
        uint256 wNow = _weekIndex(nowTs);
        while (closedWeeks < wNow) {
            uint256 w = closedWeeks;
            weekEligibleTotal[w] = openEligibleTotal;
            emit BoostWeekClosed(w, openEligibleTotal, weekBoost[w]);
            if (openEligibleTotal == 0 && weekBoost[w] > 0) {
                weekBoost[w + 1] += weekBoost[w];
                weekBoost[w] = 0;
            }
            closedWeeks++;
            // The next week opens with the stake currently in force as its
            // candidate eligible total; withdrawals during it subtract below.
            openEligibleTotal = _totalStakedAll();
        }
    }

    /// @dev A user's eligible stake for week `w`, from their snapshot record.
    ///      A mark inside `w` decides by the start-of-week amount (void if
    ///      they withdrew that week); no mark inside `w` means their stake
    ///      never changed during `w`, so the mirrored total is the amount
    ///      that stood for the whole week.
    function _eligibleAmountFor(
        BoostInfo storage b,
        uint256 w
    ) internal view returns (uint256) {
        if (b.marked && b.markWeek == w) {
            return b.weekDirty ? 0 : b.weekStartAmount;
        }
        if (b.marked && b.markWeek > w) return 0; // unreachable by construction; defensive
        return b.stakeTotal;
    }

    function _settleUserBoost(
        address _user
    ) internal {
        BoostInfo storage b = boostInfo[_user];
        while (b.settledWeek < closedWeeks) {
            uint256 w = b.settledWeek;
            uint256 amt = _eligibleAmountFor(b, w);
            if (amt > 0 && weekEligibleTotal[w] > 0) {
                b.credit += weekBoost[w] * amt / weekEligibleTotal[w];
            }
            b.settledWeek++;
        }
    }

    /// @dev Snapshot hook, run settle-before-change on every stake change.
    ///      The first event of a week records the stake in force at the
    ///      week's start; a withdrawal during the week voids that stake for
    ///      the week and removes it from the week's eligible total.
    function _boostTouch(
        address _user,
        bool _isWithdrawal,
        uint256 _amount
    ) internal {
        BoostInfo storage b = boostInfo[_user];
        uint256 w = currentWeek();
        if (!b.marked || b.markWeek != w) {
            b.weekStartAmount = b.stakeTotal;
            b.markWeek = w;
            b.marked = true;
            b.weekDirty = false;
        }
        // A withdrawal only dirties the week it lands in — activity before
        // the farm start precedes week 0 rather than sitting inside it.
        if (_isWithdrawal && _amount > 0) {
            b.lastWithdrawAt = block.timestamp;
            if (block.timestamp >= poolStartTime + w * weekLength && !b.weekDirty) {
                b.weekDirty = true;
                openEligibleTotal -= b.weekStartAmount;
            }
        }
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
            uint256 shareReward = generated * pool.allocPoint / (totalAllocPoint + boostWeight());
            // slither-disable-next-line divide-before-multiply
            accSharePerShare += shareReward * 1e18 / tokenSupply;
        }
        return user.amount * accSharePerShare / 1e18 - user.rewardDebt;
    }

    function massUpdatePools() public {
        // Settle the boost under the current weights before any pool update
        // or reweight reads the new denominator.
        _settleBoost();
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
            uint256 shareReward = generated * pool.allocPoint / (totalAllocPoint + boostWeight());
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
        _settleBoost();
        _settleUserBoost(msg.sender);
        _boostTouch(msg.sender, false, _amount);
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
            BoostInfo storage b = boostInfo[msg.sender];
            b.stakeTotal += _amount;
            if (block.timestamp < poolStartTime) {
                // Staked before week 0 opens: in force at its start, so it
                // counts toward week 0 eligibility in full.
                b.weekStartAmount = b.stakeTotal;
                openEligibleTotal += _amount;
            }
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
        _settleBoost();
        _settleUserBoost(msg.sender);
        _boostTouch(msg.sender, true, _amount);
        updatePool(_pid);
        uint256 pending = user.amount * pool.accSharePerShare / 1e18 - user.rewardDebt;
        if (pending > 0) {
            _safeShareTransfer(msg.sender, pending);
            emit RewardPaid(msg.sender, pending);
        }
        if (_amount > 0) {
            user.amount -= _amount;
            pool.token.safeTransfer(msg.sender, _amount);
            BoostInfo storage b = boostInfo[msg.sender];
            b.stakeTotal -= _amount;
            if (block.timestamp < poolStartTime) {
                // Left before week 0 opens: the remainder is what stands at
                // its start (handled as a smaller stake, not a dirty week).
                b.weekStartAmount = b.stakeTotal;
                openEligibleTotal -= _amount;
            }
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
        _settleBoost();
        _settleUserBoost(msg.sender);
        _boostTouch(msg.sender, true, amount);
        user.amount = 0;
        user.rewardDebt = 0;
        if (amount > 0) {
            BoostInfo storage b = boostInfo[msg.sender];
            b.stakeTotal -= amount;
            if (block.timestamp < poolStartTime) {
                b.weekStartAmount = b.stakeTotal;
                openEligibleTotal -= amount;
            }
        }
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
