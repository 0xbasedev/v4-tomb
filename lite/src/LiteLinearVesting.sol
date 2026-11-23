// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {ILiteERC20} from "./XTombLite.sol";

/// @notice Nonrevocable one-beneficiary vesting. Separate Team/Dev/Treasury/Arb instances.
/// @dev Adapted from the tested MasonryLinearVesting logic without external dependencies.
contract LiteLinearVesting {
    ILiteERC20 public immutable token;
    address public immutable beneficiary;
    address public immutable funder;
    uint64 public immutable start;
    uint64 public immutable end;

    bool public funded;
    uint256 public vestedTotal;
    uint256 public upfrontReleased;
    uint256 public released;
    uint256 private entered;

    error InvalidSchedule();
    error Unauthorized();
    error AlreadyFunded();
    error NothingToRelease();
    error TransferFailed();
    error Reentrancy();

    event Funded(uint256 upfront, uint256 vestedAmount);
    event Released(address indexed beneficiary, uint256 amount);

    modifier lock() {
        if (entered != 0) revert Reentrancy();
        entered = 1;
        _;
        entered = 0;
    }

    constructor(
        address token_, address beneficiary_, address funder_,
        uint64 start_, uint64 duration_
    ) {
        if (token_.code.length == 0 || beneficiary_ == address(0) ||
            funder_ == address(0) || start_ < block.timestamp ||
            duration_ == 0 || uint256(start_) + duration_ > type(uint64).max) revert InvalidSchedule();
        token = ILiteERC20(token_);
        beneficiary = beneficiary_;
        funder = funder_;
        start = start_;
        end = start_ + duration_;
    }

    function fund(uint256 upfront, uint256 vestAmount) external lock {
        if (msg.sender != funder) revert Unauthorized();
        if (funded) revert AlreadyFunded();
        if (block.timestamp >= start || upfront + vestAmount == 0) revert InvalidSchedule();
        funded = true;
        upfrontReleased = upfront;
        vestedTotal = vestAmount;
        uint256 beforeBalance = token.balanceOf(address(this));
        _take(upfront + vestAmount);
        if (token.balanceOf(address(this)) - beforeBalance != upfront + vestAmount) revert TransferFailed();
        if (upfront != 0) _send(beneficiary, upfront);
        emit Funded(upfront, vestAmount);
    }

    function vested() public view returns (uint256) {
        if (!funded || block.timestamp <= start) return 0;
        if (block.timestamp >= end) return vestedTotal;
        return vestedTotal * (block.timestamp - start) / (end - start);
    }

    function releasable() public view returns (uint256) {
        return vested() - released;
    }

    function release() external lock returns (uint256 amount) {
        amount = releasable();
        if (amount == 0) revert NothingToRelease();
        released += amount;
        _send(beneficiary, amount);
        emit Released(beneficiary, amount);
    }

    function _take(uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(abi.encodeWithSelector(
            ILiteERC20.transferFrom.selector, msg.sender, address(this), amount
        ));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _send(address to, uint256 amount) internal {
        (bool ok, bytes memory data) = address(token).call(abi.encodeWithSelector(
            ILiteERC20.transfer.selector, to, amount
        ));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
