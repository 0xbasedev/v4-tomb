// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Non-revocable, single-beneficiary vesting stream with a separately
/// funded immediate release. Deploy distinct streams even when beneficiaries
/// share an address (e.g. Team and Developer). Does not mint tokens.
/// @dev Default launch duration: 180 days (the exact six-month interval
/// must be selected and disclosed in the chain's launch configuration).
contract MasonryLinearVesting is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable asset;
    address public immutable beneficiary;
    uint64 public immutable start;
    uint64 public immutable end;

    bool public funded;
    uint256 public upfrontReleased;
    uint256 public vestingTotal;
    uint256 public released;

    error InvalidSchedule();
    error AlreadyFunded();
    error NotFunded();
    error NothingToRelease();
    error UnderfundedEscrow();

    event Funded(uint256 upfront, uint256 vested);
    event VestedReleased(address indexed beneficiary, uint256 amount);

    constructor(IERC20 asset_, address beneficiary_, uint64 start_, uint64 duration_)
        Ownable(msg.sender)
    {
        if (
            address(asset_) == address(0) || beneficiary_ == address(0) || duration_ == 0
                || uint256(start_) < block.timestamp
        ) revert InvalidSchedule();
        asset = asset_;
        beneficiary = beneficiary_;
        start = start_;
        end = start_ + duration_;
    }

    /// @notice Fund exactly once before vesting starts. Upfront tokens are
    /// paid to beneficiary now. Remaining tokens stay fully escrowed.
    function fund(uint256 upfront, uint256 vestedAmount) external onlyOwner nonReentrant {
        if (funded) revert AlreadyFunded();
        if (block.timestamp > start || upfront + vestedAmount == 0) revert InvalidSchedule();
        funded = true;
        upfrontReleased = upfront;
        vestingTotal = vestedAmount;
        uint256 previous = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), upfront + vestedAmount);
        if (asset.balanceOf(address(this)) - previous != upfront + vestedAmount) revert UnderfundedEscrow();
        if (upfront > 0) asset.safeTransfer(beneficiary, upfront);
        emit Funded(upfront, vestedAmount);
    }

    function vested() public view returns (uint256) {
        if (!funded || block.timestamp <= start) return 0;
        if (block.timestamp >= end) return vestingTotal;
        return vestingTotal * (block.timestamp - start) / (end - start);
    }

    function releasable() public view returns (uint256) {
        return vested() - released;
    }

    /// @notice Anyone may trigger delivery, but tokens always go to the
    /// immutable beneficiary. There is deliberately no owner sweep.
    function release() external nonReentrant returns (uint256 amount) {
        if (!funded) revert NotFunded();
        amount = releasable();
        if (amount == 0) revert NothingToRelease();
        released += amount;
        asset.safeTransfer(beneficiary, amount);
        emit VestedReleased(beneficiary, amount);
    }
}
