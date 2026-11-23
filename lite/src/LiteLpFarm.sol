// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ILiteERC20, ILitePriceSource} from "./XTombLite.sol";

/// @notice Pre-funded xSHARE farm for one chain-configured canonical V2 LP.
/// @dev Deploy separately for xTOMB/USDC and xSHARE/USDC LP.
///      Emissions end after 365 days. No owner sweep; all rewards must be funded before activation.
///      A stale oracle never blocks eligible withdrawals: fee goes to zero.
contract LiteLpFarm {
    uint256 public constant DURATION = 365 days;
    uint256 public constant PRECISION = 1e27;
    uint256 public constant MAX_WITHDRAW_FEE_BPS = 300;
    uint256 public constant ORACLE_MAX_AGE = 30 minutes;

    ILiteERC20 public immutable lp;
    ILiteERC20 public immutable reward;
    ILitePriceSource public immutable pegPrice;
    address public immutable owner;
    address public immutable treasury;
    uint256 public immutable startAt;
    uint16 public immutable maxWithdrawFeeBps;

    bool public activated;
    uint256 public rewardRate;
    uint256 public endAt;
    uint256 public lastUpdate;
    uint256 public rewardIndex;
    uint256 public totalStaked;
    uint256 private entered;
    mapping(address => uint256) public staked;
    mapping(address => uint256) public rewardDebt;
    mapping(address => uint256) public accrued;

    error BadConfig();
    error Unauthorized();
    error NotStarted();
    error TransferFailed();
    error Reentrancy();

    event Activated(uint256 budget, uint256 ratePerSecond, uint256 start, uint256 end);
    event Staked(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 returnedLp, uint256 treasuryFee);
    event Claimed(address indexed account, uint256 rewards);
    event EmergencyWithdrawn(address indexed account, uint256 amount, uint256 forfeitedRewards);

    modifier lock() {
        if (entered != 0) revert Reentrancy();
        entered = 1;
        _;
        entered = 0;
    }

    constructor(
        address lp_, address reward_, address pegPrice_, address owner_,
        address treasury_, uint256 startAt_, uint16 maxWithdrawFeeBps_
    ) {
        if (lp_.code.length == 0 || reward_.code.length == 0 ||
            pegPrice_.code.length == 0 || lp_ == reward_ || owner_ == address(0) ||
            treasury_ == address(0) || startAt_ <= block.timestamp ||
            maxWithdrawFeeBps_ > MAX_WITHDRAW_FEE_BPS) revert BadConfig();
        lp = ILiteERC20(lp_);
        reward = ILiteERC20(reward_);
        pegPrice = ILitePriceSource(pegPrice_);
        owner = owner_;
        treasury = treasury_;
        startAt = startAt_;
        maxWithdrawFeeBps = maxWithdrawFeeBps_;
    }

    /// @notice Exactly one pre-start budget allocation; no subsequent inflation or rate changes.
    function activate(uint256 budget) external lock {
        if (msg.sender != owner) revert Unauthorized();
        if (activated || block.timestamp >= startAt || budget < DURATION) revert BadConfig();
        uint256 initial = reward.balanceOf(address(this));
        _take(address(reward), msg.sender, budget);
        if (reward.balanceOf(address(this)) - initial != budget) revert TransferFailed();
        activated = true;
        rewardRate = budget / DURATION;
        endAt = startAt + DURATION;
        lastUpdate = startAt;
        emit Activated(budget, rewardRate, startAt, endAt);
    }

    function _now() internal view returns (uint256) {
        return block.timestamp < endAt ? block.timestamp : endAt;
    }

    function _update() internal {
        if (!activated || block.timestamp <= startAt) return;
        uint256 current = _now();
        if (current <= lastUpdate) return;
        if (totalStaked != 0) {
            rewardIndex += ((current - lastUpdate) * rewardRate * PRECISION) / totalStaked;
        }
        lastUpdate = current;
    }

    function _accrue(address user) internal {
        uint256 newAcc = staked[user] * rewardIndex / PRECISION;
        accrued[user] += newAcc - rewardDebt[user];
        rewardDebt[user] = newAcc;
    }

    function _refreshDebt(address user) internal {
        rewardDebt[user] = staked[user] * rewardIndex / PRECISION;
    }

    function pending(address account) external view returns (uint256) {
        uint256 index = rewardIndex;
        if (activated && block.timestamp > startAt && totalStaked != 0) {
            uint256 current = _now();
            if (current > lastUpdate) index += (current - lastUpdate) * rewardRate * PRECISION / totalStaked;
        }
        return accrued[account] + staked[account] * index / PRECISION - rewardDebt[account];
    }

    function stake(uint256 amount) external lock {
        if (!activated || block.timestamp < startAt) revert NotStarted();
        if (amount == 0) revert BadConfig();
        _update();
        _accrue(msg.sender);
        uint256 beforeBalance = lp.balanceOf(address(this));
        _take(address(lp), msg.sender, amount);
        if (lp.balanceOf(address(this)) - beforeBalance != amount) revert TransferFailed();
        totalStaked += amount;
        staked[msg.sender] += amount;
        _refreshDebt(msg.sender);
        emit Staked(msg.sender, amount);
    }

    function withdrawalFeeBps() public view returns (uint256) {
        if (maxWithdrawFeeBps == 0) return 0;
        uint256 price;
        uint256 observedAt;
        try pegPrice.latestPrice() returns (uint256 p, uint256 t) {
            price = p;
            observedAt = t;
        } catch { return 0; }
        if (price == 0 || observedAt == 0 || observedAt > block.timestamp ||
            block.timestamp - observedAt > ORACLE_MAX_AGE || price >= 1e18) return 0;
        if (price <= 0.85e18) return maxWithdrawFeeBps;
        uint256 progress = (1e18 - price) * 10_000 / 0.15e18;
        return uint256(maxWithdrawFeeBps) * progress * progress / 100_000_000;
    }

    /// @notice Withdraw anytime, including below peg. If oracle is stale, fee is 0.
    function withdraw(uint256 amount) external lock {
        if (amount == 0 || amount > staked[msg.sender]) revert BadConfig();
        _update();
        _accrue(msg.sender);
        staked[msg.sender] -= amount;
        totalStaked -= amount;
        _refreshDebt(msg.sender);
        uint256 fee = amount * withdrawalFeeBps() / 10_000;
        _send(address(lp), treasury, fee);
        _send(address(lp), msg.sender, amount - fee);
        emit Withdrawn(msg.sender, amount - fee, fee);
    }

    function claim() external lock {
        _update();
        _accrue(msg.sender);
        uint256 amount = accrued[msg.sender];
        if (amount == 0) revert BadConfig();
        accrued[msg.sender] = 0;
        _send(address(reward), msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /// @notice No peg gate to exit. Forgoes accrued rewards, returns full LP.
    function emergencyWithdraw() external lock {
        uint256 amount = staked[msg.sender];
        if (amount == 0) revert BadConfig();
        _update();
        _accrue(msg.sender);
        uint256 forfeited = accrued[msg.sender];
        accrued[msg.sender] = 0;
        staked[msg.sender] = 0;
        rewardDebt[msg.sender] = 0;
        totalStaked -= amount;
        _send(address(lp), msg.sender, amount);
        emit EmergencyWithdrawn(msg.sender, amount, forfeited);
    }

    function _take(address token, address user, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(ILiteERC20.transferFrom.selector, user, address(this), amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _send(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(ILiteERC20.transfer.selector, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
