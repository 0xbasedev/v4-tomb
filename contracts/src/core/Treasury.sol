// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ContractGuard} from "../libs/ContractGuard.sol";
import {IBasisAsset} from "../interfaces/IBasisAsset.sol";
import {IBoardroom} from "../interfaces/IBoardroom.sol";
import {IOracle} from "../interfaces/IOracle.sol";

/**
 * @title Treasury
 * @notice The seigniorage engine. Ticks every 6 hours: reads the OLDM/cbETH TWAP, decides
 *         expansion or contraction, mints $OLDM to TheClub (Boardroom) during expansion,
 *         opens a discounted $TRUSTNOTE bond window during contraction, and redeems bonds
 *         from the treasury reserve during expansion.
 * @dev    Direct port of Tomb Finance's Treasury.sol (bombmoney/bomb-contracts).
 *
 *         Branded as "Trustees" in Old Money docs/UI; the on-chain class name is `Treasury`
 *         to match Tomb's source one-for-one for auditor familiarity.
 *
 *         Modernizations applied (no logic changes):
 *         - 0.6.12 → 0.8.26; SafeMath dropped (built-in overflow).
 *         - OZ v4 SafeERC20.safeApprove → OZ v5 SafeERC20.forceApprove (v5 removed
 *           safeApprove; forceApprove handles the reset-then-set race condition internally).
 *         - `require` strings → custom errors.
 *         - `excludedFromTotalSupply` accepted as an init argument rather than hardcoded
 *           addresses (deploy ergonomics; semantically equivalent — still a one-shot set).
 *         - Peg target: `oldmPriceOne = 1e18` (1 OLDM = 1 cbETH on Base). Tomb used 1e14
 *           (10,000 BOMB = 1 BTC). All `1e14` literals in Tomb's math are replaced with
 *           `oldmPriceOne` here — same algebra, different scale.
 */
contract Treasury is ContractGuard {
    using SafeERC20 for IERC20;

    /* =================== CONSTANTS =================== */

    uint256 public constant PERIOD = 6 hours;

    /* =================== STATE =================== */

    address public operator;
    bool public initialized;

    uint256 public startTime;
    uint256 public epoch;
    uint256 public epochSupplyContractionLeft;

    address[] public excludedFromTotalSupply;

    // Core protocol tokens + dependencies.
    address public oldm;
    address public trustnote;
    address public estate;
    address public boardroom;
    address public oracle;

    // Peg
    uint256 public oldmPriceOne;
    uint256 public oldmPriceCeiling;
    uint256 public seigniorageSaved;

    uint256[] public supplyTiers;
    uint256[] public maxExpansionTiers;

    uint256 public maxSupplyExpansionPercent;
    uint256 public bondDepletionFloorPercent;
    uint256 public seigniorageExpansionFloorPercent;
    uint256 public maxSupplyContractionPercent;
    uint256 public maxDebtRatioPercent;

    uint256 public bootstrapEpochs;
    uint256 public bootstrapSupplyExpansionPercent;

    uint256 public previousEpochOldmPrice;
    uint256 public maxDiscountRate;
    uint256 public maxPremiumRate;
    uint256 public discountPercent;
    uint256 public premiumThreshold;
    uint256 public premiumPercent;
    uint256 public mintingFactorForPayingDebt;

    address public daoFund;
    uint256 public daoFundSharedPercent;
    address public devFund;
    uint256 public devFundSharedPercent;

    /* =================== EVENTS =================== */

    event Initialized(address indexed executor, uint256 at);
    event BurnedBonds(address indexed from, uint256 bondAmount);
    event RedeemedBonds(address indexed from, uint256 oldmAmount, uint256 bondAmount);
    event BoughtBonds(address indexed from, uint256 oldmAmount, uint256 bondAmount);
    event TreasuryFunded(uint256 timestamp, uint256 seigniorage);
    event BoardroomFunded(uint256 timestamp, uint256 seigniorage);
    event DaoFundFunded(uint256 timestamp, uint256 seigniorage);
    event DevFundFunded(uint256 timestamp, uint256 seigniorage);

    /* =================== ERRORS =================== */

    error NotOperator();
    error AlreadyInitialized();
    error NotStarted();
    error NotEpochYet();
    error InsufficientPermissions();

    error CannotPurchaseWithZero();
    error PriceMoved();
    error PriceNotEligible();
    error NotEnoughBondLeft();
    error InvalidBondRate();
    error OverMaxDebtRatio();
    error InsufficientTreasuryBudget();
    error CannotRedeemZero();

    error CeilingOutOfRange();
    error ExpansionPercentOutOfRange();
    error TierIndexOutOfRange();
    error TierValueNotMonotonic();
    error BondDepletionFloorOutOfRange();
    error SupplyContractionOutOfRange();
    error DebtRatioOutOfRange();
    error BootstrapEpochsOutOfRange();
    error BootstrapPercentOutOfRange();
    error FundShareOutOfRange();
    error ZeroAddress();
    error DiscountPercentTooHigh();
    error PremiumThresholdOutOfRange();
    error PremiumPercentTooHigh();
    error MintingFactorOutOfRange();
    error ProtectedToken();

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
        epochSupplyContractionLeft =
            (getOldmPrice() > oldmPriceCeiling) ? 0 : getOldmCirculatingSupply() * maxSupplyContractionPercent / 10_000;
    }

    modifier checkOperator() {
        if (
            IBasisAsset(oldm).operator() != address(this) || IBasisAsset(trustnote).operator() != address(this)
                || IBasisAsset(estate).operator() != address(this) || IBoardroom(boardroom).operator() != address(this)
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

    function getOldmPrice() public view returns (uint256) {
        try IOracle(oracle).consult(oldm, 1e18) returns (uint144 price) {
            return uint256(price);
        } catch {
            revert("Treasury: failed to consult OLDM price from the oracle");
        }
    }

    function getOldmUpdatedPrice() public view returns (uint256) {
        try IOracle(oracle).twap(oldm, 1e18) returns (uint144 price) {
            return uint256(price);
        } catch {
            revert("Treasury: failed to consult OLDM price from the oracle");
        }
    }

    function getReserve() public view returns (uint256) {
        return seigniorageSaved;
    }

    function getBurnableOldmLeft() public view returns (uint256 burnableLeft) {
        uint256 price = getOldmPrice();
        if (price <= oldmPriceOne) {
            uint256 oldmSupply = getOldmCirculatingSupply();
            uint256 bondMaxSupply = oldmSupply * maxDebtRatioPercent / 10_000;
            uint256 bondSupply = IERC20(trustnote).totalSupply();
            if (bondMaxSupply > bondSupply) {
                uint256 maxMintableBond = bondMaxSupply - bondSupply;
                uint256 maxBurnableOldm = maxMintableBond * price / oldmPriceOne;
                burnableLeft = Math.min(epochSupplyContractionLeft, maxBurnableOldm);
            }
        }
    }

    function getRedeemableBonds() public view returns (uint256 redeemable) {
        uint256 price = getOldmPrice();
        if (price > oldmPriceCeiling) {
            uint256 totalOldm = IERC20(oldm).balanceOf(address(this));
            uint256 rate = getBondPremiumRate();
            if (rate > 0) {
                redeemable = totalOldm * oldmPriceOne / rate;
            }
        }
    }

    function getBondDiscountRate() public view returns (uint256 rate) {
        uint256 price = getOldmPrice();
        if (price <= oldmPriceOne) {
            if (discountPercent == 0) {
                rate = oldmPriceOne;
            } else {
                uint256 bondAmount = oldmPriceOne * 1e18 / price;
                uint256 discountAmount = (bondAmount - oldmPriceOne) * discountPercent / 10_000;
                rate = oldmPriceOne + discountAmount;
                if (maxDiscountRate > 0 && rate > maxDiscountRate) rate = maxDiscountRate;
            }
        }
    }

    function getBondPremiumRate() public view returns (uint256 rate) {
        uint256 price = getOldmPrice();
        if (price > oldmPriceCeiling) {
            uint256 premiumThresholdAbs = oldmPriceOne * premiumThreshold / 100;
            if (price >= premiumThresholdAbs) {
                uint256 premiumAmount = (price - oldmPriceOne) * premiumPercent / 10_000;
                rate = oldmPriceOne + premiumAmount;
                if (maxPremiumRate > 0 && rate > maxPremiumRate) rate = maxPremiumRate;
            } else {
                rate = oldmPriceOne;
            }
        }
    }

    function getOldmCirculatingSupply() public view returns (uint256) {
        IERC20 oldmErc20 = IERC20(oldm);
        uint256 ts = oldmErc20.totalSupply();
        uint256 excluded;
        for (uint256 i = 0; i < excludedFromTotalSupply.length; ++i) {
            excluded += oldmErc20.balanceOf(excludedFromTotalSupply[i]);
        }
        return ts - excluded;
    }

    /* =================== GOVERNANCE =================== */

    function initialize(
        address _oldm,
        address _trustnote,
        address _estate,
        address _oracle,
        address _boardroom,
        uint256 _startTime,
        address[] memory _excludedFromTotalSupply
    ) public notInitialized {
        oldm = _oldm;
        trustnote = _trustnote;
        estate = _estate;
        oracle = _oracle;
        boardroom = _boardroom;
        startTime = _startTime;

        for (uint256 i = 0; i < _excludedFromTotalSupply.length; ++i) {
            excludedFromTotalSupply.push(_excludedFromTotalSupply[i]);
        }

        oldmPriceOne = 1e18; // 1 OLDM = 1 cbETH (Base peg target)
        oldmPriceCeiling = oldmPriceOne * 101 / 100;

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
        bondDepletionFloorPercent = 10_000;
        seigniorageExpansionFloorPercent = 3500;
        maxSupplyContractionPercent = 300;
        maxDebtRatioPercent = 4500;

        premiumThreshold = 110;
        premiumPercent = 7000;

        bootstrapEpochs = 0;
        bootstrapSupplyExpansionPercent = 450;

        seigniorageSaved = IERC20(oldm).balanceOf(address(this));

        initialized = true;
        operator = msg.sender;
        emit Initialized(msg.sender, block.number);
    }

    function setOperator(
        address _operator
    ) external onlyOperator {
        operator = _operator;
    }

    function setBoardroom(
        address _boardroom
    ) external onlyOperator {
        boardroom = _boardroom;
    }

    function setOracle(
        address _oracle
    ) external onlyOperator {
        oracle = _oracle;
    }

    function setOldmPriceCeiling(
        uint256 _oldmPriceCeiling
    ) external onlyOperator {
        if (_oldmPriceCeiling < oldmPriceOne || _oldmPriceCeiling > oldmPriceOne * 120 / 100) {
            revert CeilingOutOfRange();
        }
        oldmPriceCeiling = _oldmPriceCeiling;
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

    function setBondDepletionFloorPercent(
        uint256 _bondDepletionFloorPercent
    ) external onlyOperator {
        if (_bondDepletionFloorPercent < 500 || _bondDepletionFloorPercent > 10_000) {
            revert BondDepletionFloorOutOfRange();
        }
        bondDepletionFloorPercent = _bondDepletionFloorPercent;
    }

    function setMaxSupplyContractionPercent(
        uint256 _maxSupplyContractionPercent
    ) external onlyOperator {
        if (_maxSupplyContractionPercent < 100 || _maxSupplyContractionPercent > 1500) {
            revert SupplyContractionOutOfRange();
        }
        maxSupplyContractionPercent = _maxSupplyContractionPercent;
    }

    function setMaxDebtRatioPercent(
        uint256 _maxDebtRatioPercent
    ) external onlyOperator {
        if (_maxDebtRatioPercent < 1000 || _maxDebtRatioPercent > 10_000) revert DebtRatioOutOfRange();
        maxDebtRatioPercent = _maxDebtRatioPercent;
    }

    function setBootstrap(
        uint256 _bootstrapEpochs,
        uint256 _bootstrapSupplyExpansionPercent
    ) external onlyOperator {
        if (_bootstrapEpochs > 120) revert BootstrapEpochsOutOfRange();
        if (_bootstrapSupplyExpansionPercent < 100 || _bootstrapSupplyExpansionPercent > 1000) {
            revert BootstrapPercentOutOfRange();
        }
        bootstrapEpochs = _bootstrapEpochs;
        bootstrapSupplyExpansionPercent = _bootstrapSupplyExpansionPercent;
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

    function setMaxDiscountRate(
        uint256 _maxDiscountRate
    ) external onlyOperator {
        maxDiscountRate = _maxDiscountRate;
    }

    function setMaxPremiumRate(
        uint256 _maxPremiumRate
    ) external onlyOperator {
        maxPremiumRate = _maxPremiumRate;
    }

    function setDiscountPercent(
        uint256 _discountPercent
    ) external onlyOperator {
        if (_discountPercent > 20_000) revert DiscountPercentTooHigh();
        discountPercent = _discountPercent;
    }

    function setPremiumThreshold(
        uint256 _premiumThreshold
    ) external onlyOperator {
        if (_premiumThreshold < oldmPriceCeiling) revert PremiumThresholdOutOfRange();
        if (_premiumThreshold > 150) revert PremiumThresholdOutOfRange();
        premiumThreshold = _premiumThreshold;
    }

    function setPremiumPercent(
        uint256 _premiumPercent
    ) external onlyOperator {
        if (_premiumPercent > 20_000) revert PremiumPercentTooHigh();
        premiumPercent = _premiumPercent;
    }

    function setMintingFactorForPayingDebt(
        uint256 _mintingFactorForPayingDebt
    ) external onlyOperator {
        if (_mintingFactorForPayingDebt < 10_000 || _mintingFactorForPayingDebt > 20_000) {
            revert MintingFactorOutOfRange();
        }
        mintingFactorForPayingDebt = _mintingFactorForPayingDebt;
    }

    /* =================== MUTATIVE =================== */

    function _updateOldmPrice() internal {
        try IOracle(oracle).update() {} catch {}
    }

    function buyBonds(
        uint256 oldmAmount,
        uint256 targetPrice
    ) external onlyOneBlock checkCondition checkOperator {
        if (oldmAmount == 0) revert CannotPurchaseWithZero();

        uint256 price = getOldmPrice();
        if (price != targetPrice) revert PriceMoved();
        if (price >= oldmPriceOne) revert PriceNotEligible();
        if (oldmAmount > epochSupplyContractionLeft) revert NotEnoughBondLeft();

        uint256 rate = getBondDiscountRate();
        if (rate == 0) revert InvalidBondRate();

        uint256 bondAmount = oldmAmount * rate / oldmPriceOne;
        uint256 supply = getOldmCirculatingSupply();
        uint256 newBondSupply = IERC20(trustnote).totalSupply() + bondAmount;
        if (newBondSupply > supply * maxDebtRatioPercent / 10_000) revert OverMaxDebtRatio();

        IBasisAsset(oldm).burnFrom(msg.sender, oldmAmount);
        IBasisAsset(trustnote).mint(msg.sender, bondAmount);

        epochSupplyContractionLeft -= oldmAmount;
        _updateOldmPrice();

        emit BoughtBonds(msg.sender, oldmAmount, bondAmount);
    }

    function redeemBonds(
        uint256 bondAmount,
        uint256 targetPrice
    ) external onlyOneBlock checkCondition checkOperator {
        if (bondAmount == 0) revert CannotRedeemZero();

        uint256 price = getOldmPrice();
        if (price != targetPrice) revert PriceMoved();
        if (price <= oldmPriceCeiling) revert PriceNotEligible();

        uint256 rate = getBondPremiumRate();
        if (rate == 0) revert InvalidBondRate();

        uint256 oldmAmount = bondAmount * rate / oldmPriceOne;
        if (IERC20(oldm).balanceOf(address(this)) < oldmAmount) revert InsufficientTreasuryBudget();

        seigniorageSaved -= Math.min(seigniorageSaved, oldmAmount);

        IBasisAsset(trustnote).burnFrom(msg.sender, bondAmount);
        IERC20(oldm).safeTransfer(msg.sender, oldmAmount);

        _updateOldmPrice();

        emit RedeemedBonds(msg.sender, oldmAmount, bondAmount);
    }

    function _sendToBoardroom(
        uint256 amount
    ) internal {
        IBasisAsset(oldm).mint(address(this), amount);

        uint256 daoShare;
        if (daoFundSharedPercent > 0) {
            daoShare = amount * daoFundSharedPercent / 10_000;
            IERC20(oldm).safeTransfer(daoFund, daoShare);
            emit DaoFundFunded(block.timestamp, daoShare);
        }

        uint256 devShare;
        if (devFundSharedPercent > 0) {
            devShare = amount * devFundSharedPercent / 10_000;
            IERC20(oldm).safeTransfer(devFund, devShare);
            emit DevFundFunded(block.timestamp, devShare);
        }

        uint256 remaining = amount - daoShare - devShare;
        IERC20(oldm).forceApprove(boardroom, remaining);
        IBoardroom(boardroom).allocateSeigniorage(remaining);
        emit BoardroomFunded(block.timestamp, remaining);
    }

    function _calculateMaxSupplyExpansionPercent(
        uint256 supply
    ) internal returns (uint256) {
        // Walk tiers high → low; first one we exceed sets the cap.
        for (uint256 tierId = 8;; --tierId) {
            if (supply >= supplyTiers[tierId]) {
                maxSupplyExpansionPercent = maxExpansionTiers[tierId];
                break;
            }
            if (tierId == 0) break;
        }
        return maxSupplyExpansionPercent;
    }

    function allocateSeigniorage() external onlyOneBlock checkCondition checkEpoch checkOperator {
        _updateOldmPrice();
        previousEpochOldmPrice = getOldmPrice();
        uint256 supply = getOldmCirculatingSupply() - seigniorageSaved;

        if (epoch < bootstrapEpochs) {
            _sendToBoardroom(supply * bootstrapSupplyExpansionPercent / 10_000);
        } else if (previousEpochOldmPrice > oldmPriceCeiling) {
            // Expansion.
            uint256 bondSupply = IERC20(trustnote).totalSupply();
            uint256 percentage = previousEpochOldmPrice - oldmPriceOne;
            uint256 savedForBond;
            uint256 savedForBoardroom;
            uint256 mse = _calculateMaxSupplyExpansionPercent(supply) * oldmPriceOne / 10_000;

            if (percentage > mse) percentage = mse;

            if (seigniorageSaved >= bondSupply * bondDepletionFloorPercent / 10_000) {
                savedForBoardroom = supply * percentage / oldmPriceOne;
            } else {
                uint256 seigniorage = supply * percentage / oldmPriceOne;
                savedForBoardroom = seigniorage * seigniorageExpansionFloorPercent / 10_000;
                savedForBond = seigniorage - savedForBoardroom;
                if (mintingFactorForPayingDebt > 0) {
                    savedForBond = savedForBond * mintingFactorForPayingDebt / 10_000;
                }
            }
            if (savedForBoardroom > 0) _sendToBoardroom(savedForBoardroom);
            if (savedForBond > 0) {
                seigniorageSaved += savedForBond;
                IBasisAsset(oldm).mint(address(this), savedForBond);
                emit TreasuryFunded(block.timestamp, savedForBond);
            }
        }
    }

    /* =================== RESCUES + BOARDROOM PROXIES =================== */

    function governanceRecoverUnsupported(
        IERC20 token,
        uint256 amount,
        address to
    ) external onlyOperator {
        if (address(token) == oldm) revert ProtectedToken();
        if (address(token) == trustnote) revert ProtectedToken();
        if (address(token) == estate) revert ProtectedToken();
        token.safeTransfer(to, amount);
    }

    function boardroomSetOperator(
        address _operator
    ) external onlyOperator {
        IBoardroom(boardroom).setOperator(_operator);
    }

    function boardroomSetLockUp(
        uint256 withdrawLockupEpochs,
        uint256 rewardLockupEpochs
    ) external onlyOperator {
        IBoardroom(boardroom).setLockUp(withdrawLockupEpochs, rewardLockupEpochs);
    }

    function boardroomAllocateSeigniorage(
        uint256 amount
    ) external onlyOperator {
        IBoardroom(boardroom).allocateSeigniorage(amount);
    }

    function boardroomGovernanceRecoverUnsupported(
        address token,
        uint256 amount,
        address to
    ) external onlyOperator {
        IBoardroom(boardroom).governanceRecoverUnsupported(token, amount, to);
    }
}
