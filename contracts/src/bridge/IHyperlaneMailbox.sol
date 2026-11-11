// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/// @notice The Hyperlane Mailbox methods used by the bridge and its clients.
interface IHyperlaneMailbox {
    function localDomain() external view returns (uint32);
    function recipientIsm(
        address recipient
    ) external view returns (address);
    function delivered(
        bytes32 messageId
    ) external view returns (bool);

    function quoteDispatch(
        uint32 destination,
        bytes32 recipient,
        bytes calldata body,
        bytes calldata metadata
    ) external view returns (uint256 fee);
    function dispatch(
        uint32 destination,
        bytes32 recipient,
        bytes calldata body,
        bytes calldata metadata
    ) external payable returns (bytes32 messageId);
}
