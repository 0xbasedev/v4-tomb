// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ContractGuard} from "../libs/ContractGuard.sol";
import {IBasisAsset} from "../interfaces/IBasisAsset.sol";
import {IMasonry} from "../interfaces/IMasonry.sol";
import {IOracle} from "../interfaces/IOracle.sol";

/**
 * @title Treasury
 * @notice The emissions engine. Once per 6-hour epoch it reads the peg token's TWAP and,
 *         when the price is above the ceiling, mints an expansion and pays it out: a
 *         configured cut to the DAO and dev funds, the rest to the Masonry.
 *
 *         It does nothing else. In particular:
 *           - There are no bonds. No debt is ever issued, so none is ever repaid and no
 *             premium stands between the protocol and its next expansion. Below the
 *             ceiling the Treasury simply mints nothing.
 *           - There is no bootstrap. Genesis runs before epoch 0 and every expansion from
 *             epoch 0 onward is earned by price.
 *           - It holds no protocol funds. What it mints leaves in the same transaction,
 *             and sell-tax proceeds go to the DAO wallet, never here.
 *
 * @dev    Derived from Tomb Finance's Treasury. Kept from Tomb: the epoch clock, the
 *         expansion formula (`min(price - 1, tier cap)` of circulating supply), the nine
 *         supply tiers, the DAO / dev fund cuts and the Masonry proxies. Removed: bonds,
 *         the seigniorage reserve, contraction budgeting, debt ratio and bootstrap.
 *
 *         If the Masonry has no stakers when an expansion is due, the mint is skipped
 *         rather than reverted, so an empty Masonry can never stall the epoch clock.
 */
contract Treasury is ContractGuard, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* =================== CONSTANTS =================== */

    uint256 public constant PERIOD = 6 hours;

    /* =================== STATE =================== */

    address public operator;
    bool public initialized;

    uint256 public startTime;
    uint256 public epoch;

    address[] public excludedFromTotalSupply;

    // Core protocol tokens + dependencies.
    address public peg;
    address public share;
    address public masonry;
    address public oracle;

    // Peg
    uint256 public pegPriceOne;
    uint256 public pegPriceCeiling;

    uint256[] public supplyTiers;
    uint256[] public maxExpansionTiers;

    uint256 public maxSupplyExpansionPercent;
    uint256 public previousEpochPegPrice;

    address public daoFund;
    uint256 public daoFundSharedPercent;
    address public devFund;
    uint256 public devFundSharedPercent;

    /* =================== EVENTS =================== */

    event Initialized(address indexed executor, uint256 at);
    event MasonryFunded(uint256 timestamp, uint256 seigniorage);
    event DaoFundFunded(uint256 timestamp, uint256 seigniorage);
    event DevFundFunded(uint256 timestamp, uint256 seigniorage);
    /// @notice An expansion was due but the Masonry had no stakers, so nothing was minted.
    event ExpansionSkipped(uint256 timestamp, uint256 seigniorage);

    /* =================== ERRORS =================== */

    error NotOperator();
    error AlreadyInitialized();
    error NotStarted();
    error NotEpochYet();
    error InsufficientPermissions();

    error CeilingOutOfRange();
    error ExpansionPercentOutOfRange();
    error TierIndexOutOfRange();
    error TierValueNotMonotonic();
    error FundShareOutOfRange();
    error ZeroAddress();

    /* =================== MODIFIERS =================== */

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier checkCondition() {
        if (block.timestamp < startTime) revert NotStarted();
        _;
    }

    modifier checkEpoch() {
        if (block.timestamp < nextEpochPoint()) revert NotEpochYet();
        _;
        epoch += 1;
    }

    modifier checkOperator() {
        if (
            IBasisAsset(peg).operator() != address(this) || IBasisAsset(share).operator() != address(this)
                || IMasonry(masonry).operator() != address(this)
        ) revert InsufficientPermissions();
        _;
    }

    modifier notInitialized() {
        if (initialized) revert AlreadyInitialized();
        _;
    }

    /* =================== VIEW FUNCTIONS =================== */

    function isInitialized() public view returns (bool) {
        return initialized;
    }

    function nextEpochPoint() public view returns (uint256) {
        return startTime + epoch * PERIOD;
    }

    function getPegPrice() public view returns (uint256) {
        try IOracle(oracle).consult(peg, 1e18) returns (uint144 price) {
            return uint256(price);
        } catch {
            revert("Treasury: failed to consult PEG price from the oracle");
        }
    }

    function getPegUpdatedPrice() public view returns (uint256) {
        try IOracle(oracle).twap(peg, 1e18) returns (uint144 price) {
            return uint256(price);
        } catch {
            revert("Treasury: failed to consult PEG price from the oracle");
        }
    }

    function getPegCirculatingSupply() public view returns (uint256) {
        IERC20 pegErc20 = IERC20(peg);
        uint256 ts = pegErc20.totalSupply();
        uint256 excluded = 0;
        uint256 len = excludedFromTotalSupply.length;
        for (uint256 i = 0; i < len; ++i) {
            excluded += pegErc20.balanceOf(excludedFromTotalSupply[i]);
        }
        return ts - excluded;
    }

    /// @notice What `allocateSeigniorage` would mint if it ran now at the last recorded TWAP.
    ///         Zero at or below the ceiling.
    function getExpansionAmount() public view returns (uint256) {
        uint256 price = getPegPrice();
        if (price <= pegPriceCeiling) return 0;
        uint256 supply = getPegCirculatingSupply();
        uint256 percentage = price - pegPriceOne;
        uint256 cap = _expansionCapFor(supply) * pegPriceOne / 10_000;
        if (percentage > cap) percentage = cap;
        return supply * percentage / pegPriceOne;
    }

    /* =================== GOVERNANCE =================== */

    function initialize(
        address _peg,
        address _share,
        address _oracle,
        address _masonry,
        uint256 _startTime,
        address[] memory _excludedFromTotalSupply
    ) public notInitialized {
        peg = _peg;
        share = _share;
        oracle = _oracle;
        masonry = _masonry;
        startTime = _startTime;

        for (uint256 i = 0; i < _excludedFromTotalSupply.length; ++i) {
            excludedFromTotalSupply.push(_excludedFromTotalSupply[i]);
        }

        pegPriceOne = 1e18; // 1 PEG = 1 unit of the paired asset
        pegPriceCeiling = pegPriceOne * 101 / 100;

        supplyTiers = [
            uint256(0),
            500_000 ether,
            1_000_000 ether,
            1_500_000 ether,
            2_000_000 ether,
            5_000_000 ether,
            10_000_000 ether,
            20_000_000 ether,
            50_000_000 ether
        ];
        maxExpansionTiers = [uint256(450), 400, 350, 300, 250, 200, 150, 125, 100];

        maxSupplyExpansionPercent = 400;

        initialized = true;
        operator = msg.sender;
        emit Initialized(msg.sender, block.number);
    }

    function setOperator(
        address _operator
    ) external onlyOperator {
        operator = _operator;
    }

    function setMasonry(
        address _masonry
    ) external onlyOperator {
        masonry = _masonry;
    }

    function setOracle(
        address _oracle
    ) external onlyOperator {
        oracle = _oracle;
    }

    function setPegPriceCeiling(
        uint256 _pegPriceCeiling
    ) external onlyOperator {
        if (_pegPriceCeiling < pegPriceOne || _pegPriceCeiling > pegPriceOne * 120 / 100) {
            revert CeilingOutOfRange();
        }
        pegPriceCeiling = _pegPriceCeiling;
    }

    function setMaxSupplyExpansionPercents(
        uint256 _maxSupplyExpansionPercent
    ) external onlyOperator {
        if (_maxSupplyExpansionPercent < 10 || _maxSupplyExpansionPercent > 1000) revert ExpansionPercentOutOfRange();
        maxSupplyExpansionPercent = _maxSupplyExpansionPercent;
    }

    function setSupplyTiersEntry(
        uint8 index,
        uint256 value
    ) external onlyOperator returns (bool) {
        if (index >= 9) revert TierIndexOutOfRange();
        if (index > 0 && value <= supplyTiers[index - 1]) revert TierValueNotMonotonic();
        if (index < 8 && value >= supplyTiers[index + 1]) revert TierValueNotMonotonic();
        supplyTiers[index] = value;
        return true;
    }

    function setMaxExpansionTiersEntry(
        uint8 index,
        uint256 value
    ) external onlyOperator returns (bool) {
        if (index >= 9) revert TierIndexOutOfRange();
        if (value < 10 || value > 1000) revert ExpansionPercentOutOfRange();
        maxExpansionTiers[index] = value;
        return true;
    }

    function setExtraFunds(
        address _daoFund,
        uint256 _daoFundSharedPercent,
        address _devFund,
        uint256 _devFundSharedPercent
    ) external onlyOperator {
        if (_daoFund == address(0)) revert ZeroAddress();
        if (_daoFundSharedPercent > 3000) revert FundShareOutOfRange();
        if (_devFund == address(0)) revert ZeroAddress();
        if (_devFundSharedPercent > 1000) revert FundShareOutOfRange();
        daoFund = _daoFund;
        daoFundSharedPercent = _daoFundSharedPercent;
        devFund = _devFund;
        devFundSharedPercent = _devFundSharedPercent;
    }

    /* =================== MUTATIVE =================== */

    function _updatePegPrice() internal {
        try IOracle(oracle).update() {} catch {}
    }

    /// @dev Mint `amount`, pay the fund cuts, hand the remainder to the Masonry. Nothing is
    ///      left in this contract afterwards.
    function _sendToMasonry(
        uint256 amount
    ) internal {
        require(IBasisAsset(peg).mint(address(this), amount), "Treasury: peg mint failed");

        uint256 daoShare = 0;
        if (daoFundSharedPercent > 0) {
            daoShare = amount * daoFundSharedPercent / 10_000;
            IERC20(peg).safeTransfer(daoFund, daoShare);
            emit DaoFundFunded(block.timestamp, daoShare);
        }

        uint256 devShare = 0;
        if (devFundSharedPercent > 0) {
            devShare = amount * devFundSharedPercent / 10_000;
            IERC20(peg).safeTransfer(devFund, devShare);
            emit DevFundFunded(block.timestamp, devShare);
        }

        uint256 remaining = amount - daoShare - devShare;
        IERC20(peg).forceApprove(masonry, remaining);
        IMasonry(masonry).allocateSeigniorage(remaining);
        emit MasonryFunded(block.timestamp, remaining);
    }

    /// @dev Walk tiers high to low; the first one `supply` reaches sets the cap (bps).
    function _expansionCapFor(
        uint256 supply
    ) internal view returns (uint256) {
        for (uint256 tierId = 8;; --tierId) {
            if (supply >= supplyTiers[tierId]) return maxExpansionTiers[tierId];
            if (tierId == 0) break;
        }
        return maxSupplyExpansionPercent;
    }

    // slither-disable-next-line reentrancy-no-eth
    function allocateSeigniorage() external nonReentrant onlyOneBlock checkCondition checkEpoch checkOperator {
        _updatePegPrice();
        previousEpochPegPrice = getPegPrice();
        if (previousEpochPegPrice <= pegPriceCeiling) return;

        uint256 supply = getPegCirculatingSupply();
        maxSupplyExpansionPercent = _expansionCapFor(supply);
        uint256 percentage = previousEpochPegPrice - pegPriceOne;
        uint256 cap = maxSupplyExpansionPercent * pegPriceOne / 10_000;
        if (percentage > cap) percentage = cap;

        uint256 amount = supply * percentage / pegPriceOne;
        if (amount == 0) return;

        // Nobody to pay: mint nothing rather than revert, so the clock keeps ticking.
        if (IERC20(masonry).totalSupply() == 0) {
            emit ExpansionSkipped(block.timestamp, amount);
            return;
        }
        _sendToMasonry(amount);
    }

    /* =================== RESCUES + MASONRY PROXIES =================== */

    /// @notice Sweep any token that was sent here by mistake. The Treasury is not meant to
    ///         hold a balance of anything, the protocol's own tokens included.
    function governanceRecoverUnsupported(
        IERC20 token,
        uint256 amount,
        address to
    ) external onlyOperator {
        if (to == address(0)) revert ZeroAddress();
        token.safeTransfer(to, amount);
    }

    function masonrySetOperator(
        address _operator
    ) external onlyOperator {
        IMasonry(masonry).setOperator(_operator);
    }

    function masonrySetLockUp(
        uint256 withdrawLockupEpochs,
        uint256 rewardLockupEpochs
    ) external onlyOperator {
        IMasonry(masonry).setLockUp(withdrawLockupEpochs, rewardLockupEpochs);
    }

    function masonryAllocateSeigniorage(
        uint256 amount
    ) external onlyOperator {
        IMasonry(masonry).allocateSeigniorage(amount);
    }

    function masonryGovernanceRecoverUnsupported(
        address token,
        uint256 amount,
        address to
    ) external onlyOperator {
        IMasonry(masonry).governanceRecoverUnsupported(token, amount, to);
    }
}
