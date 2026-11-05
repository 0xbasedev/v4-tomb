// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MasonryRules} from "./MasonryRules.sol";
import {MasonryGenesisPass} from "./MasonryGenesisPass.sol";
import {MasonryGenesisSchedule} from "./MasonryGenesisSchedule.sol";
import {MasonryGenesisLPBurnFee} from "./MasonryGenesisLPBurnFee.sol";

/// @notice Trusted settlement adapter. Must enforce the configured vesting, fees,
/// cooldowns and executable-price limits before settling rewards or minting LP.
interface IMasonryGenesisSettlement {
    struct CompoundPlan {
        uint256 levelToSell;
        uint256 grossShares;
    }

    function settle(
        address beneficiary,
        uint256 reward,
        bool compound,
        bool automated,
        CompoundPlan calldata plan
    ) external;
}

/// @notice Masonry Genesis staking for a standard asset and the official LP vault.
/// Claims and compounds use the same reward ledger. LP shares from either path
/// enter through one fee assessment, and only net shares earn rewards.
contract MasonryGenesisStaking is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 private constant ACC_PRECISION = 1e24;
    uint256 public constant COMPOUND_COOLDOWN = MasonryRules.COMPOUND_COOLDOWN;
    uint256 public constant ULTRA_EARLY_ACCESS = 1 days;
    /// @notice Pool-0 deposit fee by pass tier, paid in USDC to the pass Treasury.
    /// Pool 1 (LP vault) is not charged here; it uses the LP fee module.
    uint16 public constant GENESIS_DEPOSIT_FEE_BPS = 300;
    uint16 public constant PRO_DEPOSIT_FEE_BPS = 200;
    uint16 public constant ULTRA_DEPOSIT_FEE_BPS = 0;
    uint256 private constant BPS = 10_000;

    struct Pool {
        uint256 totalStaked;
        uint256 lastEmitted;
        uint256 accLevel;
    }

    struct Position {
        uint256 shares;
        uint256 paidPerShare;
        uint256 pending;
    }

    MasonryGenesisPass public immutable pass;
    MasonryGenesisSchedule public immutable schedule;
    MasonryGenesisLPBurnFee public immutable lpFee;
    IMasonryGenesisSettlement public immutable settlement;
    IERC20 public immutable standardAsset;
    IERC20 public immutable lpAsset;
    IERC20 public immutable level;
    uint256 public immutable rewardBudget;

    Pool[2] public pools;
    mapping(uint256 => mapping(address => Position)) public positions;
    mapping(address => address) public keeper;
    mapping(address => uint256) public minimumNetCompoundShares;
    mapping(uint256 => mapping(address => uint256)) public nextCompoundAt;
    bool public funded;

    error InvalidConfiguration();
    error InvalidPool();
    error NotEligible();
    error PoolClosed();
    error InvalidAmount();
    error Unfunded();
    error Cooldown();

    event Staked(address indexed beneficiary, uint256 indexed pool, uint256 netShares);
    event DepositFeePaid(address indexed beneficiary, MasonryGenesisPass.Tier tier, uint256 fee);
    event Withdrawn(address indexed beneficiary, uint256 indexed pool, uint256 shares);
    event Settled(address indexed beneficiary, uint256 indexed sourcePool, uint256 levelAmount, bool compounded);

    constructor(
        MasonryGenesisPass pass_,
        MasonryGenesisLPBurnFee lpFee_,
        IMasonryGenesisSettlement settlement_,
        IERC20 standardAsset_,
        uint256 budget
    ) {
        pass = pass_;
        schedule = pass_.schedule();
        lpFee = lpFee_;
        settlement = settlement_;
        level = IERC20(address(lpFee_.level()));
        lpAsset = IERC20(address(lpFee_.lpVault()));
        standardAsset = standardAsset_;
        if (
            standardAsset_ == lpAsset || standardAsset_ == level || lpAsset == level
                || address(standardAsset_).code.length == 0 || address(settlement_).code.length == 0
                || lpFee_.usdc() != pass_.usdc() || standardAsset_ != lpFee_.usdc() || budget == 0
        ) revert InvalidConfiguration();
        rewardBudget = budget;
    }

    function fund() external nonReentrant {
        uint256 start = schedule.start();
        if (funded || (start != 0 && block.timestamp >= start)) revert InvalidConfiguration();
        _receive(level, rewardBudget);
        funded = true;
    }

    function deposit(
        uint256 pool,
        uint256 amount
    ) external nonReentrant {
        if (!funded) revert Unfunded();
        MasonryGenesisPass.Tier tier = _member(msg.sender);
        IERC20 asset = _asset(pool);
        if (pool == 1) {
            if (!schedule.lpOpen()) revert PoolClosed();
        } else if (!schedule.active()) {
            uint256 start = schedule.start();
            if (
                tier != MasonryGenesisPass.Tier.Ultra || block.timestamp >= start
                    || start - block.timestamp > ULTRA_EARLY_ACCESS
            ) revert PoolClosed();
        }

        _checkpoint(pool, msg.sender);
        _receive(asset, amount);
        uint256 fee;
        if (pool == 0) {
            fee = Math.mulDiv(amount, depositFeeBps(tier), BPS);
            if (fee != 0) {
                asset.safeTransfer(pass.treasury(), fee);
                emit DepositFeePaid(msg.sender, tier, fee);
            }
        }
        _credit(pool, msg.sender, amount - fee);
    }

    function depositFeeBps(
        MasonryGenesisPass.Tier tier
    ) public pure returns (uint16) {
        if (tier == MasonryGenesisPass.Tier.Genesis) return GENESIS_DEPOSIT_FEE_BPS;
        if (tier == MasonryGenesisPass.Tier.Pro) return PRO_DEPOSIT_FEE_BPS;
        if (tier == MasonryGenesisPass.Tier.Ultra) return ULTRA_DEPOSIT_FEE_BPS;
        revert NotEligible();
    }

    function withdraw(
        uint256 pool,
        uint256 shares
    ) external nonReentrant {
        IERC20 asset = _asset(pool);
        _checkpoint(pool, msg.sender);
        Position storage position = positions[pool][msg.sender];
        position.shares -= shares;
        pools[pool].totalStaked -= shares;
        asset.safeTransfer(msg.sender, shares);
        emit Withdrawn(msg.sender, pool, shares);
    }

    function setKeeper(
        address executor,
        uint256 minNetShares
    ) external {
        if (executor != address(0) && (_member(msg.sender) < MasonryGenesisPass.Tier.Pro || minNetShares == 0)) {
            revert NotEligible();
        }
        keeper[msg.sender] = executor;
        minimumNetCompoundShares[msg.sender] = minNetShares;
    }

    function claim(
        uint256 pool
    ) external nonReentrant {
        _consumeCooldown(pool, msg.sender);
        uint256 reward = _takeReward(pool, msg.sender);
        level.safeTransfer(address(settlement), reward);
        settlement.settle(msg.sender, reward, false, false, IMasonryGenesisSettlement.CompoundPlan(0, 0));
        emit Settled(msg.sender, pool, reward, false);
    }

    function compoundToLP(
        uint256 sourcePool,
        address beneficiary,
        uint256 minNetShares,
        IMasonryGenesisSettlement.CompoundPlan calldata plan
    ) external nonReentrant {
        if (!schedule.lpOpen()) revert PoolClosed();
        MasonryGenesisPass.Tier tier = _member(beneficiary);
        bool automated = msg.sender != beneficiary;
        if (automated) {
            if (tier < MasonryGenesisPass.Tier.Pro || keeper[beneficiary] != msg.sender) revert NotEligible();
            minNetShares = Math.max(minNetShares, minimumNetCompoundShares[beneficiary]);
        }
        if (minNetShares == 0) revert InvalidAmount();
        _consumeCooldown(sourcePool, beneficiary);
        uint256 reward = _takeReward(sourcePool, beneficiary);

        _checkpoint(1, beneficiary);
        uint256 beforeShares = lpAsset.balanceOf(address(this));
        level.safeTransfer(address(settlement), reward);
        settlement.settle(beneficiary, reward, true, automated, plan);
        uint256 minted = lpAsset.balanceOf(address(this)) - beforeShares;
        if (_credit(1, beneficiary, minted) < minNetShares) revert InvalidAmount();
        emit Settled(beneficiary, sourcePool, reward, true);
    }

    function _consumeCooldown(
        uint256 pool,
        address beneficiary
    ) private {
        if (block.timestamp < nextCompoundAt[pool][beneficiary]) revert Cooldown();
        nextCompoundAt[pool][beneficiary] = block.timestamp + COMPOUND_COOLDOWN;
    }

    function _credit(
        uint256 pool,
        address beneficiary,
        uint256 gross
    ) private returns (uint256 net) {
        if (gross == 0) revert InvalidAmount();
        net = gross;
        if (pool == 1) {
            lpAsset.forceApprove(address(lpFee), gross);
            net -= lpFee.collectAndProcess(gross);
            lpAsset.forceApprove(address(lpFee), 0);
        }
        positions[pool][beneficiary].shares += net;
        pools[pool].totalStaked += net;
        emit Staked(beneficiary, pool, net);
    }

    function _takeReward(
        uint256 pool,
        address beneficiary
    ) private returns (uint256 reward) {
        _member(beneficiary);
        _asset(pool);
        _checkpoint(pool, beneficiary);
        Position storage position = positions[pool][beneficiary];
        reward = position.pending;
        if (reward == 0) revert InvalidAmount();
        position.pending = 0;
    }

    function _checkpoint(
        uint256 pool,
        address beneficiary
    ) private {
        Pool storage state = pools[pool];
        uint256 emitted = _cumulative(pool);
        if (state.totalStaked != 0) {
            state.accLevel += Math.mulDiv(emitted - state.lastEmitted, ACC_PRECISION, state.totalStaked);
        }
        state.lastEmitted = emitted;
        Position storage position = positions[pool][beneficiary];
        position.pending += Math.mulDiv(position.shares, state.accLevel - position.paidPerShare, ACC_PRECISION);
        position.paidPerShare = state.accLevel;
    }

    function _cumulative(
        uint256 pool
    ) private view returns (uint256) {
        uint256 start = schedule.start();
        if (start == 0 || block.timestamp <= start) return 0;
        uint256 end = schedule.end();
        uint256 elapsed = Math.min(block.timestamp, end) - start;
        uint256 total = Math.mulDiv(rewardBudget, elapsed, end - start);
        uint256 dayOne = Math.mulDiv(rewardBudget, schedule.lpOpens() - start, end - start);
        uint256 lp = total > dayOne ? Math.mulDiv(total - dayOne, 3, 4) : 0;
        return pool == 1 ? lp : total - lp;
    }

    function _receive(
        IERC20 asset,
        uint256 amount
    ) private {
        if (amount == 0) revert InvalidAmount();
        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        if (asset.balanceOf(address(this)) - beforeBalance != amount) revert InvalidAmount();
    }

    function _asset(
        uint256 pool
    ) private view returns (IERC20) {
        if (pool > 1) revert InvalidPool();
        return pool == 0 ? standardAsset : lpAsset;
    }

    function _member(
        address account
    ) private view returns (MasonryGenesisPass.Tier tier) {
        tier = pass.tierOf(account);
        if (tier == MasonryGenesisPass.Tier.None) revert NotEligible();
    }
}
