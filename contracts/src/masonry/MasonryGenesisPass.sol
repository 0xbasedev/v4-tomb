// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MasonryGenesisSchedule} from "./MasonryGenesisSchedule.sol";

/// @notice One paid, nontransferable Genesis membership per account.
contract MasonryGenesisPass is ERC721, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Tier {
        None,
        Genesis,
        Pro,
        Ultra
    }

    IERC20 public immutable usdc;
    address public immutable treasury;
    MasonryGenesisSchedule public immutable schedule;
    mapping(address => Tier) public tierOf;
    mapping(address => uint256) public tokenOf;
    uint256 private nextId;
    bool public saleOpen;

    event SaleOpenChanged(bool open);
    error Unauthorized();

    event Upgraded(address indexed holder, uint256 indexed tokenId, Tier oldTier, Tier newTier, uint256 paid);

    error InvalidConfiguration();
    error InvalidPurchase();
    error Soulbound();

    constructor(
        IERC20Metadata usdc_,
        address treasury_,
        MasonryGenesisSchedule schedule_
    ) ERC721("Masonry Genesis", "MGEN") {
        if (usdc_.decimals() != 6 || treasury_ == address(0) || address(schedule_).code.length == 0) {
            revert InvalidConfiguration();
        }
        usdc = IERC20(address(usdc_));
        treasury = treasury_;
        schedule = schedule_;
    }

    /// @notice The immutable Genesis scheduler controls the membership sale independently of staking.
    function setSaleOpen(bool open) external {
        if (msg.sender != schedule.scheduler()) revert Unauthorized();
        saleOpen = open;
        emit SaleOpenChanged(open);
    }

    function _saleAvailable() internal view returns (bool) {
        uint256 end = schedule.end();
        return saleOpen && (end == 0 || block.timestamp < end);
    }

    function price(
        Tier tier
    ) public pure returns (uint256) {
        if (tier == Tier.Genesis) return 50e6;
        if (tier == Tier.Pro) return 100e6;
        if (tier == Tier.Ultra) return 500e6;
        revert InvalidPurchase();
    }

    function purchase(
        Tier tier
    ) external nonReentrant returns (uint256 tokenId) {
        if (!_saleAvailable() || tierOf[msg.sender] != Tier.None) revert InvalidPurchase();
        uint256 cost = price(tier);
        tierOf[msg.sender] = tier;
        tokenId = ++nextId;
        tokenOf[msg.sender] = tokenId;
        usdc.safeTransferFrom(msg.sender, treasury, cost);
        _safeMint(msg.sender, tokenId);
    }

    /// @notice Move the caller's pass to a strictly higher tier by paying the price difference.
    /// @dev Same tokenId, tier changes in place; no transfer occurs, so the soulbound rule is untouched.
    function upgrade(
        Tier newTier
    ) external nonReentrant returns (uint256 paid) {
        Tier oldTier = tierOf[msg.sender];
        if (!_saleAvailable() || oldTier == Tier.None || newTier <= oldTier) {
            revert InvalidPurchase();
        }
        paid = price(newTier) - price(oldTier);
        tierOf[msg.sender] = newTier;
        usdc.safeTransferFrom(msg.sender, treasury, paid);
        emit Upgraded(msg.sender, tokenOf[msg.sender], oldTier, newTier, paid);
    }

    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        if (_ownerOf(tokenId) != address(0)) revert Soulbound();
        return super._update(to, tokenId, auth);
    }
}
