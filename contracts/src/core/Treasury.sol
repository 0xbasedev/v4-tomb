// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {ContractGuard} from "../libs/ContractGuard.sol";
import {IBasisAsset} from "../interfaces/IBasisAsset.sol";
import {IBoardroom} from "../interfaces/IBoardroom.sol";
import {IOracle} from "../interfaces/IOracle.sol";

/**
 * @title Treasury
 * @notice The seigniorage engine. Ticks every 6 hours: reads the PEG/WETH TWAP, decides
 *         expansion or contraction, mints $PEG to TheClub (Boardroom) during expansion,
 *         opens a discounted $BOND bond window during contraction, and redeems bonds
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
 *         - Peg target: `pegPriceOne = 1e18` (1 PEG = 1 WETH on Base). Tomb used 1e14
 *           (10,000 BOMB = 1 BTC). All `1e14` literals in Tomb's math are replaced with
 *           `pegPriceOne` here — same algebra, different scale.
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
    uint256 public epochSupplyContractionLeft;

    address[] public excludedFromTotalSupply;

    // Core protocol tokens + dependencies.
    address public peg;
    address public bond;
    address public share;
    address public boardroom;
    address public oracle;

    // Peg
    uint256 public pegPriceOne;
    uint256 public pegPriceCeiling;
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

    uint256 public previousEpochPegPrice;
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
    event RedeemedBonds(address indexed from, uint256 pegAmount, uint256 bondAmount);
    event BoughtBonds(address indexed from, uint256 pegAmount, uint256 bondAmount);
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
            (getPegPrice() > pegPriceCeiling) ? 0 : getPegCirculatingSupply() * maxSupplyContractionPercent / 10_000;
    }

    modifier checkOperator() {
        if (
            IBasisAsset(peg).operator() != address(this) || IBasisAsset(bond).operator() != address(this)
                || IBasisAsset(share).operator() != address(this) || IBoardroom(boardroom).operator() != address(this)
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

    function getReserve() public view returns (uint256) {
        return seigniorageSaved;
    }

    function getBurnablePegLeft() public view returns (uint256 burnableLeft) {
        uint256 price = getPegPrice();
        if (price <= pegPriceOne) {
            uint256 pegSupply = getPegCirculatingSupply();
            uint256 bondMaxSupply = pegSupply * maxDebtRatioPercent / 10_000;
            uint256 bondSupply = IERC20(bond).totalSupply();
            if (bondMaxSupply > bondSupply) {
                uint256 maxMintableBond = bondMaxSupply - bondSupply;
                uint256 maxBurnablePeg = maxMintableBond * price / pegPriceOne;
                burnableLeft = Math.min(epochSupplyContractionLeft, maxBurnablePeg);
            }
        }
    }

    function getRedeemableBonds() public view returns (uint256 redeemable) {
        uint256 price = getPegPrice();
        if (price > pegPriceCeiling) {
            uint256 totalPeg = IERC20(peg).balanceOf(address(this));
            uint256 rate = getBondPremiumRate();
            if (rate > 0) {
                redeemable = totalPeg * pegPriceOne / rate;
            }
        }
    }

    function getBondDiscountRate() public view returns (uint256 rate) {
        uint256 price = getPegPrice();
        if (price <= pegPriceOne) {
            if (discountPercent == 0) {
                rate = pegPriceOne;
            } else {
                uint256 bondAmount = pegPriceOne * 1e18 / price;
                uint256 discountAmount = (bondAmount - pegPriceOne) * discountPercent / 10_000;
                rate = pegPriceOne + discountAmount;
                if (maxDiscountRate > 0 && rate > maxDiscountRate) rate = maxDiscountRate;
            }
        }
    }

    function getBondPremiumRate() public view returns (uint256 rate) {
        uint256 price = getPegPrice();
        if (price > pegPriceCeiling) {
            uint256 premiumThresholdAbs = pegPriceOne * premiumThreshold / 100;
            if (price >= premiumThresholdAbs) {
                uint256 premiumAmount = (price - pegPriceOne) * premiumPercent / 10_000;
                rate = pegPriceOne + premiumAmount;
                if (maxPremiumRate > 0 && rate > maxPremiumRate) rate = maxPremiumRate;
            } else {
                rate = pegPriceOne;
            }
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

    /* =================== GOVERNANCE =================== */

    function initialize(
        address _peg,
        address _bond,
        address _share,
        address _oracle,
        address _boardroom,
        uint256 _startTime,
        address[] memory _excludedFromTotalSupply
    ) public notInitialized {
        peg = _peg;
        bond = _bond;
        share = _share;
        oracle = _oracle;
        boardroom = _boardroom;
        startTime = _startTime;

        for (uint256 i = 0; i < _excludedFromTotalSupply.length; ++i) {
            excludedFromTotalSupply.push(_excludedFromTotalSupply[i]);
        }

        pegPriceOne = 1e18; // 1 PEG = 1 WETH (Base peg target)
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
        bondDepletionFloorPercent = 10_000;
        seigniorageExpansionFloorPercent = 3500;
        maxSupplyContractionPercent = 300;
        // Tomb-faithful per docs/tomb-skill/SKILL.md + HOW_IT_WORKED.md: 3500 (35%).
        // Previously 4500 (45%) — fixed per TOMB_AUDIT BUG #2 (2026-05-22).
        maxDebtRatioPercent = 3500;

        premiumThreshold = 110;
        premiumPercent = 7000;

        // Tomb-faithful per docs/tomb-skill/references/HOW_IT_WORKED.md: 28 epochs (7 days
        // at 6h epochs) of guaranteed expansion to Boardroom regardless of price.
        // Previously 0 — fixed per TOMB_AUDIT BUG #1 (2026-05-22). The bootstrap phase
        // is load-bearing: it incentivizes early SHARE staking, which is what
        // prevents the Boardroom-empty bricking condition (gap #16) from triggering
        // when the protocol enters its first expansion epoch.
        bootstrapEpochs = 28;
        bootstrapSupplyExpansionPercent = 450;

        // POL bondTreasury mechanism (Tomb's _sendToBondTreasury, 5% supply/epoch to a
        // separate POL bond contract) is intentionally OMITTED from Old Money v1. See
        // docs/TOMB_AUDIT.md BUG #3 and docs/GAP_AUDIT.md. Rationale: the core peg-defense
        // mechanism (seigniorage + contraction bonds) functions identically without it;
        // POL is a long-term durability layer that can be added in a future Treasury
        // upgrade. Documenting here so auditors do not flag the missing step as a bug.

        seigniorageSaved = IERC20(peg).balanceOf(address(this));

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
        if (_premiumThreshold < pegPriceCeiling) revert PremiumThresholdOutOfRange();
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

    function _updatePegPrice() internal {
        try IOracle(oracle).update() {} catch {}
    }

    function buyBonds(
        uint256 pegAmount,
        uint256 targetPrice
    ) external nonReentrant onlyOneBlock checkCondition checkOperator {
        if (pegAmount == 0) revert CannotPurchaseWithZero();

        uint256 price = getPegPrice();
        if (price != targetPrice) revert PriceMoved();
        if (price >= pegPriceOne) revert PriceNotEligible();
        if (pegAmount > epochSupplyContractionLeft) revert NotEnoughBondLeft();

        uint256 rate = getBondDiscountRate();
        if (rate == 0) revert InvalidBondRate();

        uint256 bondAmount = pegAmount * rate / pegPriceOne;
        uint256 supply = getPegCirculatingSupply();
        uint256 newBondSupply = IERC20(bond).totalSupply() + bondAmount;
        if (newBondSupply > supply * maxDebtRatioPercent / 10_000) revert OverMaxDebtRatio();

        // Effects before interactions (CEI). The state write moves before the external
        // burnFrom/mint calls. Combined with `nonReentrant`, this is belt-and-suspenders.
        epochSupplyContractionLeft -= pegAmount;

        IBasisAsset(peg).burnFrom(msg.sender, pegAmount);
        require(IBasisAsset(bond).mint(msg.sender, bondAmount), "Treasury: bond mint failed");

        _updatePegPrice();

        emit BoughtBonds(msg.sender, pegAmount, bondAmount);
    }

    function redeemBonds(
        uint256 bondAmount,
        uint256 targetPrice
    ) external nonReentrant onlyOneBlock checkCondition checkOperator {
        if (bondAmount == 0) revert CannotRedeemZero();

        uint256 price = getPegPrice();
        if (price != targetPrice) revert PriceMoved();
        if (price <= pegPriceCeiling) revert PriceNotEligible();

        uint256 rate = getBondPremiumRate();
        if (rate == 0) revert InvalidBondRate();

        uint256 pegAmount = bondAmount * rate / pegPriceOne;
        if (IERC20(peg).balanceOf(address(this)) < pegAmount) revert InsufficientTreasuryBudget();

        seigniorageSaved -= Math.min(seigniorageSaved, pegAmount);

        IBasisAsset(bond).burnFrom(msg.sender, bondAmount);
        IERC20(peg).safeTransfer(msg.sender, pegAmount);

        _updatePegPrice();

        emit RedeemedBonds(msg.sender, pegAmount, bondAmount);
    }

    function _sendToBoardroom(
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
        IERC20(peg).forceApprove(boardroom, remaining);
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

    // slither-disable-next-line reentrancy-no-eth
    function allocateSeigniorage() external nonReentrant onlyOneBlock checkCondition checkEpoch checkOperator {
        _updatePegPrice();
        previousEpochPegPrice = getPegPrice();
        uint256 supply = getPegCirculatingSupply() - seigniorageSaved;

        if (epoch < bootstrapEpochs) {
            _sendToBoardroom(supply * bootstrapSupplyExpansionPercent / 10_000);
        } else if (previousEpochPegPrice > pegPriceCeiling) {
            // Expansion.
            uint256 bondSupply = IERC20(bond).totalSupply();
            uint256 percentage = previousEpochPegPrice - pegPriceOne;
            uint256 savedForBond = 0;
            uint256 savedForBoardroom = 0;
            uint256 mse = _calculateMaxSupplyExpansionPercent(supply) * pegPriceOne / 10_000;

            if (percentage > mse) percentage = mse;

            if (seigniorageSaved >= bondSupply * bondDepletionFloorPercent / 10_000) {
                savedForBoardroom = supply * percentage / pegPriceOne;
            } else {
                // Compute boardroom share with mul-before-div to avoid the
                // divide-before-multiply pattern (Slither). Algebraically equivalent to
                // Tomb's two-step (supply*pct/priceOne then *floorPct/10000) at sub-wei
                // precision, which is meaningless at our 1e23+ wei scale.
                savedForBoardroom = supply * percentage * seigniorageExpansionFloorPercent / pegPriceOne / 10_000;
                uint256 totalSeigniorage = supply * percentage / pegPriceOne;
                savedForBond = totalSeigniorage - savedForBoardroom;
                if (mintingFactorForPayingDebt > 0) {
                    savedForBond = savedForBond * mintingFactorForPayingDebt / 10_000;
                }
            }
            if (savedForBoardroom > 0) _sendToBoardroom(savedForBoardroom);
            if (savedForBond > 0) {
                // Effects-before-interactions: bump seigniorageSaved first, then mint.
                seigniorageSaved += savedForBond;
                require(IBasisAsset(peg).mint(address(this), savedForBond), "Treasury: peg mint failed");
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
        if (address(token) == peg) revert ProtectedToken();
        if (address(token) == bond) revert ProtectedToken();
        if (address(token) == share) revert ProtectedToken();
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
