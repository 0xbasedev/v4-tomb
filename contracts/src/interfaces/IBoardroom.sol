// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/**
 * @title IBoardroom
 * @notice Tomb-shape interface for the Boardroom contract. Treasury proxies a few admin
 *         calls through this interface so it doesn't need to know the full Boardroom
 *         storage layout.
 */
interface IBoardroom {
    function balanceOf(
        address member
    ) external view returns (uint256);
    function earned(
        address member
    ) external view returns (uint256);
    function canWithdraw(
        address member
    ) external view returns (bool);
    function canClaimReward(
        address member
    ) external view returns (bool);

    function epoch() external view returns (uint256);
    function nextEpochPoint() external view returns (uint256);
    function getMoneyPrice() external view returns (uint256);

    /// @notice Auto-generated getter for the Boardroom's `operator` storage field.
    function operator() external view returns (address);

    function setOperator(
        address newOperator
    ) external;
    function setLockUp(
        uint256 withdrawLockupEpochs,
        uint256 rewardLockupEpochs
    ) external;

    function stake(
        uint256 amount
    ) external;
    function withdraw(
        uint256 amount
    ) external;
    function exit() external;
    function claimReward() external;
    function allocateSeigniorage(
        uint256 amount
    ) external;

    function governanceRecoverUnsupported(
        address token,
        uint256 amount,
        address to
    ) external;
}
