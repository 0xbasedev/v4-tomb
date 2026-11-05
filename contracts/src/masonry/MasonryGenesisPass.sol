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
    uint256 private nextId;

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
        if (block.timestamp >= schedule.end() || tierOf[msg.sender] != Tier.None) revert InvalidPurchase();
        uint256 cost = price(tier);
        tierOf[msg.sender] = tier;
        tokenId = ++nextId;
        usdc.safeTransferFrom(msg.sender, treasury, cost);
        _safeMint(msg.sender, tokenId);
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
