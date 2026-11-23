// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @notice TESTNET PILOT ONLY. Minimal ERC-20 used for xTOMB and xSHARE smoke testing.
/// @dev Production tokenomics, tax hooks, allocations, and governance are NOT implemented.
contract XLiteToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public immutable cap;
    uint256 public totalSupply;
    address public immutable owner;
    address public minter;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed tokenOwner, address indexed spender, uint256 amount);
    event MinterFinalized(address indexed minter);

    error Unauthorized();
    error InvalidAddress();
    error InsufficientBalance();
    error InsufficientAllowance();
    error CapExceeded();

    constructor(
        string memory name_, string memory symbol_, uint8 decimals_,
        uint256 cap_, address owner_
    ) {
        if (owner_ == address(0) || cap_ == 0 || decimals_ > 18) revert InvalidAddress();
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        cap = cap_;
        owner = owner_;
    }

    /// @dev Before handoff, the owner may mint a separately reviewed TESTNET seed amount.
    /// After handoff ONLY the Masonry can mint. This is deliberately one-way.
    function finalizeMinter(address newMinter) external {
        if (msg.sender != owner || minter != address(0)) revert Unauthorized();
        if (newMinter == address(0)) revert InvalidAddress();
        minter = newMinter;
        emit MinterFinalized(newMinter);
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != minter && !(minter == address(0) && msg.sender == owner)) revert Unauthorized();
        if (to == address(0)) revert InvalidAddress();
        if (amount > cap - totalSupply) revert CapExceeded();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        if (approved != type(uint256).max) {
            if (approved < amount) revert InsufficientAllowance();
            unchecked { allowance[from][msg.sender] = approved - amount; }
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert InvalidAddress();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        unchecked { balanceOf[from] = balance - amount; }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

interface ILiteERC20 {
    function totalSupply() external view returns (uint256);
    function mint(address to, uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface ILitePriceSource {
    /// @notice 18-decimal USD price and UNIX observation timestamp.
    function latestPrice() external view returns (uint256 priceE18, uint256 updatedAt);
}

/// @notice Narrow xTOMB Lite prototype; HARD BLOCKED on LONGYU mainnet.
/// @dev Only intended for chain 668801, with separately verified price sources and TEST tokens.
///      Not an audited financial protocol. No bond/debt instruments or single-sided xSHARE staking.
contract XTombLiteMasonry {
    uint256 public constant TARGET_CHAIN_ID = 668801;
    uint256 public constant EPOCH_DURATION = 6 hours;
    uint256 public constant LOCK_DURATION = 6 hours;
    uint256 public constant CLAIM_COOLDOWN = 6 hours;
    uint256 public constant ORACLE_MAX_AGE = 30 minutes;
    uint256 public constant PEG_CEILING_EXCLUSIVE = 1.01e18;
    uint256 public constant MAX_EXPANSION_BPS = 200; // 2%
    uint256 private constant PRECISION = 1e27;

    ILiteERC20 public immutable xtomb;
    ILiteERC20 public immutable masonryLp;
    ILiteERC20 public immutable feeToken;
    ILitePriceSource public immutable pegTwap;
    ILitePriceSource public immutable nativeUsdPrice;
    uint256 public immutable usdcEpochFee;
    address public immutable governance;
    address public treasury;
    address public arbitrage;
    uint256 public nextEpochAt;
    uint256 public totalStaked;
    uint256 public accRewardPerShare;
    uint256 private entered;

    struct Tranche { uint128 amount; uint64 unlockAt; }
    mapping(address => Tranche[]) private tranches;
    mapping(address => uint256) public stakedBalance;
    mapping(address => uint256) public rewardDebt;
    mapping(address => uint256) public pendingRewards;
    mapping(address => uint256) public nextClaimAt;

    event Deposited(address indexed account, uint256 indexed tranche, uint256 amount);
    event Withdrawn(address indexed account, uint256 indexed tranche, uint256 amount);
    event ExitNow(address indexed account, uint256 indexed tranche, uint256 amount, uint256 forfeitedRewards);
    event Claimed(address indexed account, uint256 reward);
    event EpochAdvanced(address indexed payer, uint256 priceE18, uint256 minted, uint256 nextEpochAt);
    event FeeRecipientsUpdated(address indexed treasury, address indexed arbitrage);

    error BlockedChain();
    error Unauthorized();
    error InvalidConfig();
    error NotReady();
    error PegNotVerified();
    error TooEarly();
    error NothingToClaim();
    error Reentrancy();
    error TransferFailure();

    modifier lock() {
        if (entered != 0) revert Reentrancy();
        entered = 1;
        _;
        entered = 0;
    }

    constructor(
        address peg_, address lp_, address feeToken_, address twap_,
        address nativeUsdOracle_, address treasury_, address arbitrage_,
        address governance_, uint256 genesisStart_, uint256 feeAmount_
    ) {
        if (block.chainid != TARGET_CHAIN_ID) revert BlockedChain();
        if (peg_ == address(0) || lp_ == address(0) || feeToken_ == address(0) ||
            twap_ == address(0) || treasury_ == address(0) || arbitrage_ == address(0) ||
            governance_ == address(0) || feeAmount_ == 0 || genesisStart_ < block.timestamp
        ) revert InvalidConfig();
        if (peg_.code.length == 0 || lp_.code.length == 0 || feeToken_.code.length == 0 ||
            twap_.code.length == 0 ||
            (nativeUsdOracle_ != address(0) && nativeUsdOracle_.code.length == 0)
        ) revert InvalidConfig();
        xtomb = ILiteERC20(peg_);
        masonryLp = ILiteERC20(lp_);
        feeToken = ILiteERC20(feeToken_);
        pegTwap = ILitePriceSource(twap_);
        nativeUsdPrice = ILitePriceSource(nativeUsdOracle_);
        treasury = treasury_;
        arbitrage = arbitrage_;
        governance = governance_;
        usdcEpochFee = feeAmount_;
        nextEpochAt = genesisStart_ + EPOCH_DURATION;
    }

    function setFeeRecipients(address treasury_, address arbitrage_) external {
        if (msg.sender != governance) revert Unauthorized();
        if (treasury_ == address(0) || arbitrage_ == address(0)) revert InvalidConfig();
        treasury = treasury_;
        arbitrage = arbitrage_;
        emit FeeRecipientsUpdated(treasury_, arbitrage_);
    }

    function trancheCount(address account) external view returns (uint256) {
        return tranches[account].length;
    }

    function tranche(address account, uint256 index) external view returns (Tranche memory) {
        return tranches[account][index];
    }

    function earned(address account) external view returns (uint256) {
        return pendingRewards[account] +
            stakedBalance[account] * accRewardPerShare / PRECISION - rewardDebt[account];
    }

    function deposit(uint128 amount) external lock {
        if (amount == 0) revert InvalidConfig();
        _accrue(msg.sender);
        _take(address(masonryLp), msg.sender, amount);
        stakedBalance[msg.sender] += amount;
        totalStaked += amount;
        uint256 idx = tranches[msg.sender].length;
        tranches[msg.sender].push(Tranche(amount, uint64(block.timestamp + LOCK_DURATION)));
        if (nextClaimAt[msg.sender] == 0) nextClaimAt[msg.sender] = block.timestamp + CLAIM_COOLDOWN;
        _updateDebt(msg.sender);
        emit Deposited(msg.sender, idx, amount);
    }

    function withdraw(uint256 index, uint128 amount) external lock {
        Tranche storage t = tranches[msg.sender][index];
        if (amount == 0 || amount > t.amount) revert InvalidConfig();
        if (block.timestamp < t.unlockAt) revert TooEarly();
        _accrue(msg.sender);
        t.amount -= amount;
        stakedBalance[msg.sender] -= amount;
        totalStaked -= amount;
        _updateDebt(msg.sender);
        _send(address(masonryLp), msg.sender, amount);
        emit Withdrawn(msg.sender, index, amount);
    }

    /// @notice 50% of exited LP to Treasury and ALL pending xTOMB rewards to Arbitrage.
    function exitNow(uint256 index, uint128 amount) external lock {
        Tranche storage t = tranches[msg.sender][index];
        if (amount == 0 || amount > t.amount) revert InvalidConfig();
        _accrue(msg.sender);
        uint256 forfeited = pendingRewards[msg.sender];
        pendingRewards[msg.sender] = 0;
        t.amount -= amount;
        stakedBalance[msg.sender] -= amount;
        totalStaked -= amount;
        _updateDebt(msg.sender);
        uint256 treasuryLp = amount / 2;
        _send(address(masonryLp), treasury, treasuryLp);
        _send(address(masonryLp), msg.sender, uint256(amount) - treasuryLp);
        if (forfeited != 0) _send(address(xtomb), arbitrage, forfeited);
        emit ExitNow(msg.sender, index, amount, forfeited);
    }

    function claim() external lock {
        if (block.timestamp < nextClaimAt[msg.sender]) revert TooEarly();
        _accrue(msg.sender);
        uint256 amount = pendingRewards[msg.sender];
        if (amount == 0) revert NothingToClaim();
        pendingRewards[msg.sender] = 0;
        nextClaimAt[msg.sender] = block.timestamp + CLAIM_COOLDOWN;
        _send(address(xtomb), msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /// @notice Permissionless $25 stable-token fee per ELIGIBLE epoch, no catch-up.
    function advanceEpochUsdc() external lock {
        (uint256 price, uint256 amount) = _checkAdvance();
        _take(address(feeToken), msg.sender, treasury, usdcEpochFee);
        _advance(msg.sender, price, amount);
    }

    /// @notice Optional native fee route; requires separate fresh USD/native oracle.
    ///         Must be left DISABLED if a trustworthy native oracle is unavailable.
    function advanceEpochNative() external payable lock {
        if (address(nativeUsdPrice) == address(0)) revert InvalidConfig();
        (uint256 price, uint256 amount) = _checkAdvance();
        (uint256 nativePrice, uint256 observedAt) = nativeUsdPrice.latestPrice();
        _fresh(nativePrice, observedAt);
        uint256 requiredWei = (25e36 + nativePrice - 1) / nativePrice;
        if (msg.value < requiredWei) revert InvalidConfig();
        (bool ok,) = payable(treasury).call{value: requiredWei}("");
        if (!ok) revert TransferFailure();
        if (msg.value > requiredWei) {
            (ok,) = payable(msg.sender).call{value: msg.value - requiredWei}("");
            if (!ok) revert TransferFailure();
        }
        _advance(msg.sender, price, amount);
    }

    function _checkAdvance() internal view returns (uint256 price, uint256 amount) {
        if (block.timestamp < nextEpochAt) revert TooEarly();
        if (totalStaked == 0) revert NotReady();
        uint256 observedAt;
        (price, observedAt) = pegTwap.latestPrice();
        _fresh(price, observedAt);
        if (price <= PEG_CEILING_EXCLUSIVE) revert PegNotVerified();
        uint256 circulation = xtomb.totalSupply();
        amount = circulation * MAX_EXPANSION_BPS / 10000;
        if (amount == 0) revert NotReady();
    }

    function _advance(address payer, uint256 price, uint256 amount) internal {
        // Before any external mint, close the eligible epoch; no backlog or retroactive minting.
        nextEpochAt = block.timestamp + EPOCH_DURATION;
        accRewardPerShare += amount * PRECISION / totalStaked;
        xtomb.mint(address(this), amount);
        emit EpochAdvanced(payer, price, amount, nextEpochAt);
    }

    function _fresh(uint256 price, uint256 observedAt) internal view {
        if (price == 0 || observedAt == 0 || observedAt > block.timestamp ||
            block.timestamp - observedAt > ORACLE_MAX_AGE) revert PegNotVerified();
    }

    function _accrue(address account) internal {
        uint256 accrued = stakedBalance[account] * accRewardPerShare / PRECISION;
        pendingRewards[account] += accrued - rewardDebt[account];
        rewardDebt[account] = accrued;
    }

    function _updateDebt(address account) internal {
        rewardDebt[account] = stakedBalance[account] * accRewardPerShare / PRECISION;
    }

    function _take(address token, address from, uint256 amount) internal {
        _take(token, from, address(this), amount);
    }

    function _take(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(ILiteERC20.transferFrom.selector, from, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailure();
    }

    function _send(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(ILiteERC20.transfer.selector, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailure();
    }
}
