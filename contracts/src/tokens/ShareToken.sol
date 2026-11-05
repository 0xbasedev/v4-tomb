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
 * @notice The share token. Public name **xSHARE** for the Masonry launch; the inherited
 *         WETH-era protocol deploys the same source with its historical ESTATE profile.
 * @dev    Port of Tomb Finance's BSHARE (BShare.sol in bombmoney/bomb-contracts) with the
 *         supply schedule moved from constants into constructor configuration, so one source
 *         serves both launches:
 *
 *           - `maxSupply` is a hard cap on every unit ever minted (burns don't free room).
 *           - `initial` allocations are minted in the constructor. The Masonry launch mints its
 *             sale escrow, deployer, owner/team/developer, Treasury, arbitrage and vesting
 *             contract amounts here, reconciled to the cap by the launch validator.
 *           - `farmingAllocation` is minted once, later, by trustees via `distributeReward`
 *             (Masonry: 25,641 to the Farm when it exists; legacy: 59,500).
 *           - `communityFundAllocation` / `devFundAllocation` vest linearly over
 *             `vestingDuration` from `vestingStart` and are minted by `claimRewards`
 *             (legacy only; the Masonry profile sets both to zero and vests through
 *             MasonryLinearVesting contracts that receive initial allocations instead).
 *
 *         Legacy ESTATE profile (Tomb-exact, see `ShareTokenProfiles.legacy`): cap 70,001;
 *         1 to the initial trustees; 59,500 farming; 5,500 community + 5,000 dev over 365 days.
 *
 *         Quirk preserved from Tomb: `setTreasuryFund` and `setDevFund` are gated to `devFund`.
 */
contract ShareToken is ERC20Burnable, ERC20Permit, Trustees {
    using SafeERC20 for IERC20;

    struct Allocation {
        address to;
        uint256 amount;
    }

    struct Config {
        string name;
        string symbol;
        uint256 maxSupply;
        Allocation[] initial;
        uint256 farmingAllocation;
        uint256 communityFundAllocation;
        uint256 devFundAllocation;
        uint256 vestingStart;
        uint256 vestingDuration;
        address communityFund;
        address devFund;
    }

    /// @notice Hard cap on cumulative minting.
    uint256 public immutable maxSupply;

    /// @notice Farming allocation, minted one-shot via `distributeReward`.
    uint256 public immutable FARMING_POOL_REWARD_ALLOCATION;

    /// @notice Community fund allocation, linear-vested over `VESTING_DURATION`.
    uint256 public immutable COMMUNITY_FUND_POOL_ALLOCATION;

    /// @notice Dev fund allocation, linear-vested over `VESTING_DURATION`.
    uint256 public immutable DEV_FUND_POOL_ALLOCATION;

    /// @notice Duration over which the community and dev funds vest linearly.
    uint256 public immutable VESTING_DURATION;

    /// @notice Timestamp at which vesting begins.
    uint256 public immutable startTime;

    /// @notice Timestamp at which vesting completes.
    uint256 public immutable endTime;

    /// @notice Per-second emission rate to the community fund (constant).
    uint256 public immutable communityFundRewardRate;

    /// @notice Per-second emission rate to the dev fund (constant).
    uint256 public immutable devFundRewardRate;

    /// @notice Cumulative units minted (never decreases; burns are tracked separately).
    uint256 public totalMinted;

    /// @notice Cumulative units burned.
    uint256 public totalBurned;

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
    error CapExceeded();
    error InvalidConfiguration();

    constructor(
        Config memory config,
        address initialTrustees
    ) ERC20(config.name, config.symbol) ERC20Permit(config.name) Trustees(initialTrustees) {
        if (config.maxSupply == 0) revert InvalidConfiguration();
        if (config.communityFundAllocation != 0 && config.communityFund == address(0)) revert ZeroAddress();
        if (config.devFundAllocation != 0 && config.devFund == address(0)) revert ZeroAddress();
        if ((config.communityFundAllocation | config.devFundAllocation) != 0 && config.vestingDuration == 0) {
            revert InvalidConfiguration();
        }

        uint256 initialTotal;
        for (uint256 i; i < config.initial.length; ++i) {
            if (config.initial[i].to == address(0)) revert ZeroAddress();
            initialTotal += config.initial[i].amount;
        }
        uint256 scheduled =
            initialTotal + config.farmingAllocation + config.communityFundAllocation + config.devFundAllocation;
        if (scheduled > config.maxSupply) revert CapExceeded();

        maxSupply = config.maxSupply;
        FARMING_POOL_REWARD_ALLOCATION = config.farmingAllocation;
        COMMUNITY_FUND_POOL_ALLOCATION = config.communityFundAllocation;
        DEV_FUND_POOL_ALLOCATION = config.devFundAllocation;
        VESTING_DURATION = config.vestingDuration;
        startTime = config.vestingStart;
        endTime = config.vestingStart + config.vestingDuration;
        communityFundLastClaimed = config.vestingStart;
        devFundLastClaimed = config.vestingStart;
        communityFundRewardRate = config.vestingDuration == 0 ? 0 : config.communityFundAllocation / config.vestingDuration;
        devFundRewardRate = config.vestingDuration == 0 ? 0 : config.devFundAllocation / config.vestingDuration;
        communityFund = config.communityFund;
        devFund = config.devFund;

        for (uint256 i; i < config.initial.length; ++i) {
            if (config.initial[i].amount != 0) _mint(config.initial[i].to, config.initial[i].amount);
        }
    }

    // ---------------------------------------------------------------------
    // Supply accounting
    // ---------------------------------------------------------------------

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override {
        if (from == address(0)) {
            totalMinted += value;
            if (totalMinted > maxSupply) revert CapExceeded();
        }
        if (to == address(0)) totalBurned += value;
        super._update(from, to, value);
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

    /// @notice Amount currently claimable by `communityFund`.
    function unclaimedTreasuryFund() public view returns (uint256) {
        uint256 _now = block.timestamp;
        if (_now > endTime) _now = endTime;
        if (communityFundLastClaimed >= _now) return 0;
        return (_now - communityFundLastClaimed) * communityFundRewardRate;
    }

    /// @notice Amount currently claimable by `devFund`.
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

    /// @notice Mint the farming allocation in a single call. Callable at most once by trustees.
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

    /// @notice Burn from the caller's own balance.
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

/// @notice Ready-made ShareToken configurations.
library ShareTokenProfiles {
    /// @notice The inherited protocol's Tomb-exact ESTATE schedule.
    function legacy(
        uint256 vestingStart,
        address communityFund,
        address devFund,
        address initialTrustees
    ) internal pure returns (ShareToken.Config memory c) {
        c.name = "Estate";
        c.symbol = "ESTATE";
        c.maxSupply = 70_001 ether;
        c.initial = new ShareToken.Allocation[](1);
        c.initial[0] = ShareToken.Allocation(initialTrustees, 1 ether);
        c.farmingAllocation = 59_500 ether;
        c.communityFundAllocation = 5500 ether;
        c.devFundAllocation = 5000 ether;
        c.vestingStart = vestingStart;
        c.vestingDuration = 365 days;
        c.communityFund = communityFund;
        c.devFund = devFund;
    }

    /// @notice The Masonry launch's xSHARE: every unit is accounted for up front.
    /// @param initial  Minted at deploy (sale escrow, deployer, owner/team/developer,
    ///                 Treasury, arbitrage and the MasonryLinearVesting contracts).
    /// @param farming  Minted once to the Farm via `distributeReward`.
    /// @param cap      Configured max supply; `initial + farming` must equal it exactly,
    ///                 matching config/masonry-launch.mjs (which rejects any other sum).
    function masonry(
        ShareToken.Allocation[] memory initial,
        uint256 farming,
        uint256 cap
    ) internal pure returns (ShareToken.Config memory c) {
        uint256 total = farming;
        for (uint256 i; i < initial.length; ++i) {
            total += initial[i].amount;
        }
        if (total != cap) revert ShareToken.InvalidConfiguration();
        c.name = "xSHARE";
        c.symbol = "xSHARE";
        c.maxSupply = cap;
        c.initial = initial;
        c.farmingAllocation = farming;
    }
}
