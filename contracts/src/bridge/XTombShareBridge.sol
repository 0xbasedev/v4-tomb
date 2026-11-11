// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IHyperlaneMailbox} from "./IHyperlaneMailbox.sol";
import {XTombBridgedShare} from "./XTombBridgedShare.sol";

/// @notice Moves xSHARE between its home chain and one of three satellites through Hyperlane.
contract XTombShareBridge is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Route {
        address peer;
        bool outboundEnabled;
        uint256 limit;
    }

    struct PeerConfig {
        uint32 domain;
        address peer;
        uint256 limit;
    }

    uint256 public constant DESTINATION_GAS = 200_000;

    IHyperlaneMailbox public immutable mailbox;
    // Hyperlane calls this getter to select the verifier for this recipient.
    address public immutable interchainSecurityModule;
    uint32 public immutable localDomain;
    uint32 public immutable canonicalDomain;
    bool public immutable isCanonical;
    address public immutable asset;

    uint256 public nextNonce = 1;
    mapping(uint32 domain => Route) public routes;
    mapping(uint32 domain => bool) public inboundPaused;
    mapping(uint32 domain => uint256) public lockedFor;
    mapping(uint32 origin => mapping(uint256 nonce => bool)) public received;

    event PeerRegistered(uint32 indexed domain, address indexed peer, uint256 limit);
    event OutboundEnabledSet(uint32 indexed domain, bool enabled);
    event InboundPausedSet(uint32 indexed domain, bool paused);
    event TransferSent(
        bytes32 indexed messageId,
        uint32 indexed destination,
        address indexed sender,
        address recipient,
        uint256 amount,
        uint256 nonce,
        uint256 fee
    );
    event TransferReceived(uint32 indexed origin, uint256 indexed nonce, address indexed recipient, uint256 amount);

    error InvalidConfiguration();
    error InvalidRoute(uint32 domain);
    error OutboundDisabled(uint32 domain);
    error InboundPaused(uint32 domain);
    error InvalidTransfer();
    error InvalidFee(uint256 expected, uint256 supplied);
    error InvalidTokenDelta();
    error OnlyMailbox();
    error InvalidPeer(uint32 origin, bytes32 sender);
    error AlreadyReceived(uint32 origin, uint256 nonce);
    error RouteLimitExceeded(uint32 domain);
    error InsufficientEscrow(uint32 origin);

    constructor(
        address mailbox_,
        address ism_,
        uint32 canonicalDomain_,
        address asset_,
        address owner_,
        PeerConfig[] memory initialPeers
    ) Ownable(owner_) {
        if (mailbox_.code.length == 0 || ism_.code.length == 0) revert InvalidConfiguration();
        uint32 domain = IHyperlaneMailbox(mailbox_).localDomain();
        if (domain != block.chainid || !_supported(domain) || !_supported(canonicalDomain_)) {
            revert InvalidConfiguration();
        }
        mailbox = IHyperlaneMailbox(mailbox_);
        interchainSecurityModule = ism_;
        localDomain = domain;
        canonicalDomain = canonicalDomain_;
        isCanonical = domain == canonicalDomain_;

        if (asset_.code.length == 0 || IERC20Metadata(asset_).decimals() != 18) revert InvalidConfiguration();
        if (!isCanonical && XTombBridgedShare(asset_).bridge() != address(this)) revert InvalidConfiguration();
        asset = asset_;

        for (uint256 i; i < initialPeers.length; ++i) {
            PeerConfig memory peer = initialPeers[i];
            _registerPeer(peer.domain, peer.peer, peer.limit);
        }
    }

    /// @notice Registers the immutable peer and maximum outstanding amount for a route.
    /// @dev Register the same limit at both ends. Outbound transfers require explicit activation.
    function registerPeer(
        uint32 domain,
        address peer,
        uint256 limit
    ) external onlyOwner {
        _registerPeer(domain, peer, limit);
    }

    function _registerPeer(
        uint32 domain,
        address peer,
        uint256 limit
    ) private {
        if (
            !_supported(domain) || domain == localDomain || (!isCanonical && domain != canonicalDomain)
                || peer == address(0) || limit == 0 || routes[domain].peer != address(0)
        ) revert InvalidRoute(domain);

        routes[domain] = Route({peer: peer, outboundEnabled: false, limit: limit});
        emit PeerRegistered(domain, peer, limit);
    }

    /// @notice Disables or enables new sends. Authenticated in-flight messages can still settle.
    function setOutboundEnabled(
        uint32 domain,
        bool enabled
    ) external onlyOwner {
        Route storage route = routes[domain];
        if (route.peer == address(0)) revert InvalidRoute(domain);
        route.outboundEnabled = enabled;
        emit OutboundEnabledSet(domain, enabled);
    }

    /// @notice Pauses settlement from a registered peer during a verification incident.
    /// @dev A reverted delivery remains eligible for retry through the Mailbox after unpausing.
    function setInboundPaused(
        uint32 domain,
        bool paused
    ) external onlyOwner {
        if (routes[domain].peer == address(0)) revert InvalidRoute(domain);
        inboundPaused[domain] = paused;
        emit InboundPausedSet(domain, paused);
    }

    /// @notice Quotes the current Hyperlane fee in the source chain's native currency.
    function quoteSend(
        uint32 destination,
        address recipient,
        uint256 amount
    ) external view returns (uint256) {
        bytes32 peer = _validateSend(destination, recipient, amount);
        return mailbox.quoteDispatch(destination, peer, abi.encode(recipient, amount, nextNonce), _hookMetadata());
    }

    /// @notice Locks canonical xSHARE or burns bridged xSHARE and dispatches a message.
    function send(
        uint32 destination,
        address recipient,
        uint256 amount
    ) external payable nonReentrant returns (bytes32 messageId) {
        bytes32 peer = _validateSend(destination, recipient, amount);
        uint256 nonce = nextNonce++;
        bytes memory body = abi.encode(recipient, amount, nonce);
        bytes memory metadata = _hookMetadata();
        uint256 fee = mailbox.quoteDispatch(destination, peer, body, metadata);
        if (msg.value != fee) revert InvalidFee(fee, msg.value);

        if (isCanonical) {
            lockedFor[destination] += amount;
            IERC20 token = IERC20(asset);
            uint256 balanceBefore = token.balanceOf(address(this));
            token.safeTransferFrom(msg.sender, address(this), amount);
            if (token.balanceOf(address(this)) != balanceBefore + amount) revert InvalidTokenDelta();
        } else {
            XTombBridgedShare(asset).bridgeBurn(msg.sender, amount);
        }

        messageId = mailbox.dispatch{value: fee}(destination, peer, body, metadata);
        emit TransferSent(messageId, destination, msg.sender, recipient, amount, nonce, fee);
    }

    /// @notice Settles an authenticated message delivered by the local Hyperlane Mailbox.
    function handle(
        uint32 origin,
        bytes32 sender,
        bytes calldata body
    ) external nonReentrant {
        if (msg.sender != address(mailbox)) revert OnlyMailbox();
        Route storage route = routes[origin];
        if (route.peer == address(0) || sender != _toBytes32(route.peer)) revert InvalidPeer(origin, sender);
        if (inboundPaused[origin]) revert InboundPaused(origin);
        if (body.length != 96) revert InvalidTransfer();

        (address recipient, uint256 amount, uint256 nonce) = abi.decode(body, (address, uint256, uint256));
        if (recipient == address(0) || recipient == address(this) || amount == 0 || nonce == 0) {
            revert InvalidTransfer();
        }
        if (received[origin][nonce]) revert AlreadyReceived(origin, nonce);
        received[origin][nonce] = true;

        if (isCanonical) {
            uint256 locked = lockedFor[origin];
            if (amount > locked) revert InsufficientEscrow(origin);
            lockedFor[origin] = locked - amount;
            IERC20 token = IERC20(asset);
            uint256 balanceBefore = token.balanceOf(address(this));
            uint256 recipientBefore = token.balanceOf(recipient);
            token.safeTransfer(recipient, amount);
            if (
                token.balanceOf(address(this)) != balanceBefore - amount
                    || token.balanceOf(recipient) != recipientBefore + amount
            ) revert InvalidTokenDelta();
        } else {
            XTombBridgedShare wrapped = XTombBridgedShare(asset);
            if (amount > route.limit - wrapped.totalSupply()) revert RouteLimitExceeded(origin);
            wrapped.bridgeMint(recipient, amount);
        }

        emit TransferReceived(origin, nonce, recipient, amount);
    }

    function _validateSend(
        uint32 destination,
        address recipient,
        uint256 amount
    ) private view returns (bytes32) {
        Route storage route = routes[destination];
        if (!route.outboundEnabled) revert OutboundDisabled(destination);
        if (recipient == address(0) || recipient == route.peer || amount == 0) revert InvalidTransfer();
        if (isCanonical && amount > route.limit - lockedFor[destination]) revert RouteLimitExceeded(destination);
        return _toBytes32(route.peer);
    }

    function _hookMetadata() private view returns (bytes memory) {
        // Hyperlane StandardHookMetadata v1. No destination value and native fees.
        return abi.encodePacked(uint16(1), uint256(0), DESTINATION_GAS, msg.sender);
    }

    function _toBytes32(
        address account
    ) private pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }

    function _supported(
        uint32 domain
    ) private pure returns (bool) {
        return domain == 8453 || domain == 56 || domain == 369 || domain == 146;
    }
}
