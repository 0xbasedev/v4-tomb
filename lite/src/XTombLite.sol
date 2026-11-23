// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

interface ILiteERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
    function mint(address to, uint256 amount) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface ILitePriceSource {
    function latestPrice() external view returns (uint256 priceE18, uint256 updatedAt);
}

interface ILiteTaxPolicy {
    function token() external view returns (address);
    function canonicalPair() external view returns (address);
    function quoteAndRecord(uint256 gross) external returns (uint16 bps);
}

interface ILitePoolPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @notice ERC-20 for xTOMB or xSHARE. Chain-agnostic, immutable cap, one-way mint authority,
///         optional one-time sell-only policy for a single canonical V2 pair.
/// @dev This is an un-audited reference implementation. Any unregistered pools can bypass
///      official transfer tax; treat cross-pool bypass as a release blocker.
contract XLiteToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public immutable cap;
    uint256 public totalSupply;
    address public immutable owner;
    address public minter;
    bool public minterFinalized;
    bool public taxConfigured;
    address public canonicalPool;
    address public taxRecipient;
    address public liquidityAdapter;
    ILiteTaxPolicy public taxPolicy;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed tokenOwner, address indexed spender, uint256 amount);
    event MinterFinalized(address indexed minter);
    event TaxConfigured(address indexed pool, address indexed policy, address recipient, address adapter);

    error Unauthorized();
    error InvalidAddress();
    error InsufficientBalance();
    error InsufficientAllowance();
    error CapExceeded();
    error InvalidPolicy();

    constructor(
        string memory name_, string memory symbol_, uint8 decimals_,
        uint256 cap_, address owner_
    ) {
        if (owner_ == address(0) || cap_ == 0 || decimals_ != 18) revert InvalidAddress();
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        cap = cap_;
        owner = owner_;
    }

    /// @notice One-way tax configuration. Exempts ONLY assets held by the reviewed LP adapter.
    function configureTax(address pool_, address policy_, address recipient_, address adapter_) external {
        if (msg.sender != owner || taxConfigured || minterFinalized) revert Unauthorized();
        if (pool_ == address(0) || recipient_ == address(0) ||
            policy_.code.length == 0 || adapter_.code.length == 0 ||
            ILiteTaxPolicy(policy_).token() != address(this) ||
            ILiteTaxPolicy(policy_).canonicalPair() != pool_) revert InvalidPolicy();
        canonicalPool = pool_;
        taxPolicy = ILiteTaxPolicy(policy_);
        taxRecipient = recipient_;
        liquidityAdapter = adapter_;
        taxConfigured = true;
        emit TaxConfigured(pool_, policy_, recipient_, adapter_);
    }

    function finalizeMinter(address newMinter) external {
        if (msg.sender != owner || minterFinalized || newMinter == address(0)) revert Unauthorized();
        minter = newMinter;
        minterFinalized = true;
        emit MinterFinalized(newMinter);
    }

    function mint(address to, uint256 amount) external {
        if (minterFinalized ? msg.sender != minter : msg.sender != owner) revert Unauthorized();
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
            emit Approval(from, msg.sender, allowance[from][msg.sender]);
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert InvalidAddress();
        uint256 balance = balanceOf[from];
        if (balance < amount) revert InsufficientBalance();
        // A genuine LP add moves user tokens to the reviewed adapter, then adapter->pair.
        // Never exempt a generic router: that would also exempt every swap.
        uint256 tax;
        if (amount != 0 && taxConfigured && to == canonicalPool && from != liquidityAdapter) {
            uint16 bps = taxPolicy.quoteAndRecord(amount);
            if (bps > 1200) revert InvalidPolicy(); // immutable contract-side maximum
            tax = amount * bps / 10_000;
        }
        unchecked { balanceOf[from] = balance - amount; }
        if (tax != 0) {
            balanceOf[taxRecipient] += tax;
            emit Transfer(from, taxRecipient, tax);
        }
        balanceOf[to] += amount - tax;
        emit Transfer(from, to, amount - tax);
    }
}

/// @notice Omnichain xTOMB LP Masonry with strict, fail-closed $1.01 USD TWAP mint gate.
/// @dev Chain ID, tokens, LP, price sources, beneficiaries and fee denominations are runtime
///      deploy parameters. No bonds. Production requires a validated external TWAP and USD feeds.
contract XTombLiteMasonry {
    uint256 public constant EPOCH_DURATION = 6 hours;
    uint256 public constant LOCK_DURATION = 6 hours;
    uint256 public constant CLAIM_COOLDOWN = 6 hours;
    uint256 public constant ORACLE_MAX_AGE = 30 minutes;
    uint256 public constant PEG_CEILING_EXCLUSIVE = 1.01e18;
    uint256 public constant MAX_EXPANSION_BPS = 200;
    uint256 private constant PRECISION = 1e27;

    uint256 public immutable deploymentChainId;
    ILiteERC20 public immutable xtomb;
    ILiteERC20 public immutable xshare;
    ILiteERC20 public immutable masonryLp;
    ILiteERC20 public immutable feeToken;
    ILitePriceSource public immutable pegTwap;
    ILitePriceSource public immutable stableUsdPrice;
    ILitePriceSource public immutable nativeUsdPrice;
    uint256 public immutable feeTokenUnit;
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

    error WrongChain();
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
        uint256 expectedChainId_,
        address peg_, address share_, address lp_, address feeToken_,
        address twap_, address stableUsdOracle_, address nativeUsdOracle_,
        address treasury_, address arbitrage_, address governance_, uint256 genesisStart_
    ) {
        if (expectedChainId_ == 0 || block.chainid != expectedChainId_) revert WrongChain();
        if (peg_.code.length == 0 || share_.code.length == 0 || lp_.code.length == 0 ||
            feeToken_.code.length == 0 || twap_.code.length == 0 ||
            stableUsdOracle_.code.length == 0 ||
            (nativeUsdOracle_ != address(0) && nativeUsdOracle_.code.length == 0) ||
            treasury_ == address(0) || arbitrage_ == address(0) ||
            governance_ == address(0) || genesisStart_ <= block.timestamp ||
            genesisStart_ > type(uint64).max - EPOCH_DURATION) revert InvalidConfig();
        ILitePoolPair lpPair = ILitePoolPair(lp_);
        address t0 = lpPair.token0();
        address t1 = lpPair.token1();
        if (!((t0 == peg_ && t1 == share_) || (t0 == share_ && t1 == peg_))) revert InvalidConfig();
        uint8 d = ILiteERC20(feeToken_).decimals();
        if (d > 18) revert InvalidConfig();
        deploymentChainId = expectedChainId_;
        xtomb = ILiteERC20(peg_);
        xshare = ILiteERC20(share_);
        masonryLp = ILiteERC20(lp_);
        feeToken = ILiteERC20(feeToken_);
        pegTwap = ILitePriceSource(twap_);
        stableUsdPrice = ILitePriceSource(stableUsdOracle_);
        nativeUsdPrice = ILitePriceSource(nativeUsdOracle_);
        feeTokenUnit = 10 ** d;
        treasury = treasury_;
        arbitrage = arbitrage_;
        governance = governance_;
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
        uint256 beforeBalance = masonryLp.balanceOf(address(this));
        _take(address(masonryLp), msg.sender, address(this), amount);
        if (masonryLp.balanceOf(address(this)) - beforeBalance != amount) revert TransferFailure();
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

    /// @notice Immediate exit: 50% of withdrawn LP to Treasury and ALL pending rewards to Arbitrage.
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

    /// @notice Permissionless real-$25 fee, dynamically converted by a fresh quote/USD reference.
    function advanceEpochStable() external lock {
        (uint256 price, uint256 amount) = _checkAdvance();
        (uint256 stablePrice,) = _validated(stableUsdPrice);
        uint256 requiredUnits = _ceilDiv(25e18 * feeTokenUnit, stablePrice);
        uint256 treasuryBefore = feeToken.balanceOf(treasury);
        _take(address(feeToken), msg.sender, treasury, requiredUnits);
        if (feeToken.balanceOf(treasury) - treasuryBefore < requiredUnits) revert TransferFailure();
        _advance(msg.sender, price, amount);
    }

    /// @notice Optional native payment; disabled if native/USD oracle address is zero.
    function advanceEpochNative() external payable lock {
        if (address(nativeUsdPrice) == address(0)) revert InvalidConfig();
        (uint256 price, uint256 amount) = _checkAdvance();
        (uint256 nativePrice,) = _validated(nativeUsdPrice);
        uint256 requiredWei = _ceilDiv(25e36, nativePrice);
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
        (price,) = _validated(pegTwap);
        if (price <= PEG_CEILING_EXCLUSIVE) revert PegNotVerified();
        amount = xtomb.totalSupply() * MAX_EXPANSION_BPS / 10_000;
        if (amount == 0) revert NotReady();
    }

    function _advance(address payer, uint256 price, uint256 amount) internal {
        nextEpochAt = block.timestamp + EPOCH_DURATION; // Explicitly no catch-up epochs.
        accRewardPerShare += amount * PRECISION / totalStaked;
        xtomb.mint(address(this), amount);
        emit EpochAdvanced(payer, price, amount, nextEpochAt);
    }

    function _validated(ILitePriceSource source) internal view returns (uint256 price, uint256 observedAt) {
        (price, observedAt) = source.latestPrice();
        if (price == 0 || observedAt == 0 || observedAt > block.timestamp ||
            block.timestamp - observedAt > ORACLE_MAX_AGE) revert PegNotVerified();
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : 1 + (a - 1) / b;
    }

    function _accrue(address account) internal {
        uint256 accrued = stakedBalance[account] * accRewardPerShare / PRECISION;
        pendingRewards[account] += accrued - rewardDebt[account];
        rewardDebt[account] = accrued;
    }

    function _updateDebt(address account) internal {
        rewardDebt[account] = stakedBalance[account] * accRewardPerShare / PRECISION;
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
