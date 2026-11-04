// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Trustees} from "../governance/Trustees.sol";

/**
 * @title ShareToken
 * @notice Share token for the inherited WETH-based protocol, with the historical ESTATE metadata.
 *         Holders stake in the Boardroom to earn seigniorage during expansion epochs.
 * @dev    Direct port of Tomb Finance's BSHARE token (BShare.sol in bombmoney/bomb-contracts).
 *
 *         Supply (Tomb-exact):
 *           - Total max: 70,000 ESTATE
 *           - 59,500 to farming pool (minted one-shot via `distributeReward`)
 *           -  5,500 to community fund (linear-vested over 365 days, claimable via `claimRewards`)
 *           -  5,000 to dev fund (linear-vested over 365 days, claimable via `claimRewards`)
 *           - 1 ESTATE minted to the initial owner in the constructor for initial pool setup.
 *
 *         Non-logic-changing modernizations from Tomb's BShare:
 *           - 0.6.12 → 0.8.26; SafeMath dropped.
 *           - OZ v4 → OZ v5; ERC20Permit added (additive).
 *           - Single-step Ownable → Ownable2Step via [[Trustees]].
 *           - `require` strings → custom errors.
 *
 *         Quirk preserved from Tomb: `setTreasuryFund` and `setDevFund` are both gated to the
 *         `devFund` address, not to owner or trustees. This is Tomb's chosen pattern.
 */
contract ShareToken is ERC20Burnable, ERC20Permit, Trustees {
    using SafeERC20 for IERC20;

    /// @notice 59,500 ESTATE — farming pool allocation, minted one-shot via `distributeReward`.
    uint256 public constant FARMING_POOL_REWARD_ALLOCATION = 59_500 ether;

    /// @notice 5,500 ESTATE — community fund, linear-vested over `VESTING_DURATION`.
    uint256 public constant COMMUNITY_FUND_POOL_ALLOCATION = 5500 ether;

    /// @notice 5,000 ESTATE — dev fund, linear-vested over `VESTING_DURATION`.
    uint256 public constant DEV_FUND_POOL_ALLOCATION = 5000 ether;

    /// @notice 365 days — duration over which community and dev fund vest linearly.
    uint256 public constant VESTING_DURATION = 365 days;

    /// @notice Timestamp at which vesting begins.
    uint256 public immutable startTime;

    /// @notice Timestamp at which vesting completes.
    uint256 public immutable endTime;

    /// @notice Per-second emission rate to the community fund (constant).
    uint256 public immutable communityFundRewardRate;

    /// @notice Per-second emission rate to the dev fund (constant).
    uint256 public immutable devFundRewardRate;

    /// @notice Address receiving the community fund vesting drip.
    address public communityFund;

    /// @notice Address receiving the dev fund vesting drip.
    address public devFund;

    /// @notice Last timestamp at which community fund vesting was claimed.
    uint256 public communityFundLastClaimed;

    /// @notice Last timestamp at which dev fund vesting was claimed.
    uint256 public devFundLastClaimed;

    /// @notice True after `distributeReward` has been called. One-shot.
    bool public rewardPoolDistributed;

    event RewardPoolDistributed(address indexed farmingIncentiveFund);
    event CommunityFundUpdated(address indexed previous, address indexed next);
    event DevFundUpdated(address indexed previous, address indexed next);
    event UnsupportedTokenRecovered(IERC20 indexed token, uint256 amount, address indexed to);

    error AlreadyDistributed();
    error ZeroAddress();
    error NotDevFund();

    constructor(
        uint256 _startTime,
        address _communityFund,
        address _devFund,
        address initialTrustees
    ) ERC20("Estate", "ESTATE") ERC20Permit("Estate") Trustees(initialTrustees) {
        if (_communityFund == address(0)) revert ZeroAddress();
        if (_devFund == address(0)) revert ZeroAddress();

        // Tomb-faithful: mint 1 unit to deployer for initial pool setup / sanity check.
        _mint(initialTrustees, 1 ether);

        startTime = _startTime;
        endTime = _startTime + VESTING_DURATION;

        communityFundLastClaimed = _startTime;
        devFundLastClaimed = _startTime;

        communityFundRewardRate = COMMUNITY_FUND_POOL_ALLOCATION / VESTING_DURATION;
        devFundRewardRate = DEV_FUND_POOL_ALLOCATION / VESTING_DURATION;

        communityFund = _communityFund;
        devFund = _devFund;
    }

    // ---------------------------------------------------------------------
    // devFund-controlled fund rotation (Tomb's quirk preserved)
    // ---------------------------------------------------------------------

    /// @notice Rotate the community fund recipient.
    /// @dev Note the Tomb quirk: this is gated to `devFund`, not to owner. Matches BShare.
    function setTreasuryFund(
        address newCommunityFund
    ) external {
        if (msg.sender != devFund) revert NotDevFund();
        if (newCommunityFund == address(0)) revert ZeroAddress();
        emit CommunityFundUpdated(communityFund, newCommunityFund);
        communityFund = newCommunityFund;
    }

    /// @notice Rotate the dev fund recipient.
    /// @dev Note the Tomb quirk: this is gated to `devFund`, not to owner. Matches BShare.
    function setDevFund(
        address newDevFund
    ) external {
        if (msg.sender != devFund) revert NotDevFund();
        if (newDevFund == address(0)) revert ZeroAddress();
        emit DevFundUpdated(devFund, newDevFund);
        devFund = newDevFund;
    }

    // ---------------------------------------------------------------------
    // Linear vesting math
    // ---------------------------------------------------------------------

    /// @notice Amount of $ESTATE currently claimable by `communityFund`.
    function unclaimedTreasuryFund() public view returns (uint256) {
        uint256 _now = block.timestamp;
        if (_now > endTime) _now = endTime;
        if (communityFundLastClaimed >= _now) return 0;
        return (_now - communityFundLastClaimed) * communityFundRewardRate;
    }

    /// @notice Amount of $ESTATE currently claimable by `devFund`.
    function unclaimedDevFund() public view returns (uint256) {
        uint256 _now = block.timestamp;
        if (_now > endTime) _now = endTime;
        if (devFundLastClaimed >= _now) return 0;
        return (_now - devFundLastClaimed) * devFundRewardRate;
    }

    /// @notice Claim any pending community + dev fund vesting drips.
    /// @dev Permissionless — anyone can poke the contract to mint due rewards.
    function claimRewards() external {
        uint256 communityPending = unclaimedTreasuryFund();
        if (communityPending > 0 && communityFund != address(0)) {
            _mint(communityFund, communityPending);
            communityFundLastClaimed = block.timestamp;
        }
        uint256 devPending = unclaimedDevFund();
        if (devPending > 0 && devFund != address(0)) {
            _mint(devFund, devPending);
            devFundLastClaimed = block.timestamp;
        }
    }

    // ---------------------------------------------------------------------
    // One-shot farming pool distribution
    // ---------------------------------------------------------------------

    /// @notice Mint the farming pool allocation in a single call. Callable at most once by trustees.
    function distributeReward(
        address farmingIncentiveFund
    ) external onlyTrustees {
        if (rewardPoolDistributed) revert AlreadyDistributed();
        if (farmingIncentiveFund == address(0)) revert ZeroAddress();
        rewardPoolDistributed = true;
        _mint(farmingIncentiveFund, FARMING_POOL_REWARD_ALLOCATION);
        emit RewardPoolDistributed(farmingIncentiveFund);
    }

    // ---------------------------------------------------------------------
    // Burn (Tomb-faithful surface)
    // ---------------------------------------------------------------------

    /// @notice Burn $ESTATE from the caller's own balance.
    /// @dev Override preserves Tomb's explicit public restatement of the inherited symbol.
    function burn(
        uint256 amount
    ) public override {
        super.burn(amount);
    }

    // ---------------------------------------------------------------------
    // Stuck-token rescue
    // ---------------------------------------------------------------------

    /// @notice Rescue an arbitrary ERC20 mistakenly sent to this contract.
    function governanceRecoverUnsupported(
        IERC20 token,
        uint256 amount,
        address to
    ) external onlyTrustees {
        token.safeTransfer(to, amount);
        emit UnsupportedTokenRecovered(token, amount, to);
    }
}
