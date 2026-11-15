// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {MasonryGenesisPass} from "./MasonryGenesisPass.sol";
import {MasonryGenesisSchedule} from "./MasonryGenesisSchedule.sol";

/// @notice Tranche sale of xSHARE for Genesis pass holders.
///
/// Shares only sell in fixed tranches of whole shares. Every share in a
/// tranche costs the same, and the per-share price rises by `priceStep` with
/// each tranche sold: tranche `t` (0-based) costs
/// `trancheSize * (startPrice + t * priceStep)` USDC. With the launch values
/// (20 tranches of 5 shares, 100 USDC start, 5 USDC step) the last tranche is
/// 195 USDC a share and a full sell-out raises 14,750 USDC.
///
/// - Buying needs two things: a Genesis pass, and an auction pass bought here
///   for `auctionPassPrice` USDC (60 at launch). The auction pass is a
///   one-time, non-refundable, non-transferable entry fee per wallet, paid to
///   the treasury. It makes spreading purchases across many wallets cost money.
/// - A wallet that just bought a tranche cannot buy the next one. It has to
///   wait until a different wallet buys; nobody takes two tranches in a row.
/// - Of each tranche, `upfrontPerTranche` shares (1 at launch) are paid to the
///   buyer at purchase. The rest (4 at launch) stay here and unlock one
///   tranche at a time: once the sale window closes, every `vestingEpoch`
///   seconds (36 hours at launch, i.e. six 6-hour protocol epochs) each
///   buyer unlocks the vesting part of one of their tranches. Someone who
///   bought 3 tranches unlocks 4 shares after each of the first 3 steps.
///   Buyers claim what has unlocked.
/// - The sale mints nothing. It only sells xSHARE that was transferred in
///   beforehand, so the allocation it comes from is decided off this contract.
/// - Every payment goes straight to the Genesis pass treasury (the DAO wallet);
///   the contract never holds USDC.
/// - It opens the moment Genesis ends and stays open for `duration` seconds.
///   Until the Genesis start date is scheduled it is closed.
/// - There is no owner and no setter. After the window closes anyone can send
///   unsold shares to the treasury.
contract MasonryShareSale is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable share;
    IERC20 public immutable usdc;
    MasonryGenesisPass public immutable pass;
    MasonryGenesisSchedule public immutable schedule;
    address public immutable treasury;

    /// @dev Base units of one whole share (10 ** share decimals).
    uint256 public immutable shareUnit;
    uint256 public immutable trancheCount;
    /// @notice Whole shares in each tranche.
    uint256 public immutable trancheSize;
    /// @notice Whole shares of each tranche paid out at purchase; the rest vest.
    uint256 public immutable upfrontPerTranche;
    /// @notice USDC per share in the first tranche.
    uint256 public immutable startPrice;
    /// @notice USDC added to the per-share price after each tranche.
    uint256 public immutable priceStep;
    uint256 public immutable duration;
    /// @notice Seconds per unlock step, counted from the close of the sale window.
    uint256 public immutable vestingEpoch;
    /// @notice One-time USDC entry fee per wallet.
    uint256 public immutable auctionPassPrice;

    /// @notice Tranches sold so far.
    uint256 public tranchesSold;
    /// @notice The wallet that bought the most recent tranche; it must sit the next one out.
    address public lastBuyer;
    /// @notice Wallets that have paid the auction pass fee.
    mapping(address => bool) public hasAuctionPass;
    uint256 public auctionPassesSold;
    /// @notice Whole shares bought per wallet (upfront and vesting together).
    mapping(address => uint256) public boughtBy;
    /// @notice Whole shares placed into vesting per wallet.
    mapping(address => uint256) public vestingOf;
    /// @notice Share base units already claimed per wallet.
    mapping(address => uint256) public claimedBy;
    uint256 public totalClaimed;

    event Bought(address indexed buyer, uint256 indexed tranche, uint256 shares, uint256 cost);
    event Claimed(address indexed buyer, uint256 shareAmount);
    event AuctionPassBought(address indexed buyer, uint256 price);
    event UnsoldSwept(uint256 shareAmount);

    error InvalidConfiguration();
    error NotOpen();
    error StillOpen();
    error PassRequired();
    error AuctionPassRequired();
    error AlreadyHasAuctionPass();
    error SaleOver();
    error NothingToClaim();
    error WaitForAnotherBuyer();
    error CostAboveMax();
    error NotFunded();

    constructor(
        IERC20Metadata share_,
        MasonryGenesisPass pass_,
        uint256 trancheCount_,
        uint256 trancheSize_,
        uint256 upfrontPerTranche_,
        uint256 startPrice_,
        uint256 priceStep_,
        uint256 duration_,
        uint256 vestingEpoch_,
        uint256 auctionPassPrice_
    ) {
        if (
            address(share_).code.length == 0 || address(pass_).code.length == 0 || trancheCount_ == 0
                || trancheSize_ == 0 || startPrice_ == 0 || duration_ == 0 || vestingEpoch_ == 0
                || upfrontPerTranche_ > trancheSize_
        ) revert InvalidConfiguration();
        share = IERC20(address(share_));
        shareUnit = 10 ** share_.decimals();
        pass = pass_;
        usdc = pass_.usdc();
        schedule = pass_.schedule();
        treasury = pass_.treasury();
        trancheCount = trancheCount_;
        trancheSize = trancheSize_;
        upfrontPerTranche = upfrontPerTranche_;
        startPrice = startPrice_;
        priceStep = priceStep_;
        duration = duration_;
        vestingEpoch = vestingEpoch_;
        auctionPassPrice = auctionPassPrice_;
    }

    /// @notice When the sale opens (Genesis end), or 0 while Genesis is unscheduled.
    function opensAt() public view returns (uint256) {
        return schedule.end();
    }

    function isOpen() public view returns (bool) {
        uint256 open = opensAt();
        return open != 0 && block.timestamp >= open && block.timestamp < open + duration && tranchesSold < trancheCount;
    }

    /// @notice Whole shares sold so far.
    function sold() external view returns (uint256) {
        return tranchesSold * trancheSize;
    }

    /// @notice USDC per share in the tranche currently on sale.
    function pricePerShare() public view returns (uint256) {
        return startPrice + tranchesSold * priceStep;
    }

    /// @notice USDC cost of the tranche currently on sale.
    function quote() public view returns (uint256) {
        return trancheSize * pricePerShare();
    }

    /// @notice Whether `account` could buy the current tranche right now.
    function canBuy(
        address account
    ) external view returns (bool) {
        return isOpen() && account != lastBuyer && hasAuctionPass[account]
            && pass.tierOf(account) != MasonryGenesisPass.Tier.None;
    }

    /// @notice Pay the one-time auction pass fee. Open to Genesis pass holders
    /// from deployment until the sale sells out or its window closes.
    function buyAuctionPass() external nonReentrant {
        if (pass.tierOf(msg.sender) == MasonryGenesisPass.Tier.None) revert PassRequired();
        if (hasAuctionPass[msg.sender]) revert AlreadyHasAuctionPass();
        uint256 open = opensAt();
        if (tranchesSold >= trancheCount || (open != 0 && block.timestamp >= open + duration)) revert SaleOver();
        hasAuctionPass[msg.sender] = true;
        ++auctionPassesSold;
        usdc.safeTransferFrom(msg.sender, treasury, auctionPassPrice);
        emit AuctionPassBought(msg.sender, auctionPassPrice);
    }

    /// @notice Buy the current tranche. `maxCost` bounds what you pay if
    /// someone else buys first and the price steps up.
    function buy(
        uint256 maxCost
    ) external nonReentrant returns (uint256 cost) {
        if (!isOpen()) revert NotOpen();
        if (pass.tierOf(msg.sender) == MasonryGenesisPass.Tier.None) revert PassRequired();
        if (!hasAuctionPass[msg.sender]) revert AuctionPassRequired();
        if (msg.sender == lastBuyer) revert WaitForAnotherBuyer();
        cost = quote();
        if (cost > maxCost) revert CostAboveMax();
        // The contract must hold this tranche on top of everything already sold and not yet claimed.
        if (share.balanceOf(address(this)) < owedToBuyers() + trancheSize * shareUnit) revert NotFunded();

        uint256 tranche = tranchesSold;
        tranchesSold = tranche + 1;
        lastBuyer = msg.sender;
        boughtBy[msg.sender] += trancheSize;
        vestingOf[msg.sender] += trancheSize - upfrontPerTranche;
        usdc.safeTransferFrom(msg.sender, treasury, cost);
        if (upfrontPerTranche != 0) share.safeTransfer(msg.sender, upfrontPerTranche * shareUnit);
        emit Bought(msg.sender, tranche, trancheSize, cost);
    }

    /// @notice When vesting starts (the sale window's close), or 0 while Genesis is unscheduled.
    function vestingStart() public view returns (uint256) {
        uint256 open = opensAt();
        return open == 0 ? 0 : open + duration;
    }

    /// @notice Share base units in vesting that buyers have not claimed yet.
    function owedToBuyers() public view returns (uint256) {
        return tranchesSold * (trancheSize - upfrontPerTranche) * shareUnit - totalClaimed;
    }

    /// @notice Share base units `account` has unlocked so far, claimed or not.
    function vestedOf(
        address account
    ) public view returns (uint256) {
        uint256 begin = vestingStart();
        if (begin == 0 || block.timestamp <= begin) return 0;
        // One tranche's vesting part per completed epoch, up to everything they bought.
        uint256 unlocked = (block.timestamp - begin) / vestingEpoch * (trancheSize - upfrontPerTranche);
        uint256 total = vestingOf[account];
        return (unlocked > total ? total : unlocked) * shareUnit;
    }

    function claimable(
        address account
    ) public view returns (uint256) {
        return vestedOf(account) - claimedBy[account];
    }

    /// @notice Collect the shares that have vested so far.
    function claim() external nonReentrant returns (uint256 amount) {
        amount = claimable(msg.sender);
        if (amount == 0) revert NothingToClaim();
        claimedBy[msg.sender] += amount;
        totalClaimed += amount;
        share.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    /// @notice After the window closes, send whatever was not sold to the
    /// treasury. Shares owed to buyers are never touched.
    function sweepUnsold() external nonReentrant {
        uint256 open = opensAt();
        if (open == 0 || block.timestamp < open + duration) revert StillOpen();
        uint256 amount = share.balanceOf(address(this)) - owedToBuyers();
        share.safeTransfer(treasury, amount);
        emit UnsoldSwept(amount);
    }
}
