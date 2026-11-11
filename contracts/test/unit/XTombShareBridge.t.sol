// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {XTombBridgedShare} from "../../src/bridge/XTombBridgedShare.sol";
import {XTombShareBridge} from "../../src/bridge/XTombShareBridge.sol";

contract BridgeTestShare is ERC20 {
    bool public chargeFee;

    constructor() ERC20("Canonical xSHARE", "xSHARE") {}

    function mint(
        address recipient,
        uint256 amount
    ) external {
        _mint(recipient, amount);
    }

    function setChargeFee(
        bool enabled
    ) external {
        chargeFee = enabled;
    }

    function _update(
        address from,
        address to,
        uint256 amount
    ) internal override {
        if (chargeFee && from != address(0) && to != address(0) && amount != 0) {
            super._update(from, address(0), 1);
            amount -= 1;
        }
        super._update(from, to, amount);
    }
}

contract BridgeTestISM {
    function moduleType() external pure returns (uint8) {
        return 6;
    }

    function verify(
        bytes calldata,
        bytes calldata
    ) external pure returns (bool) {
        return true;
    }
}

contract BridgeTestMailbox {
    uint32 public immutable localDomain;
    uint256 public constant FEE = 0.001 ether;

    bool private _failDispatch;
    uint256 private _nonce;
    uint32 public destination;
    bytes32 public receiver;
    bytes32 public sender;
    bytes public body;

    error DispatchFailed();
    error WrongFee();

    constructor(
        uint32 domain
    ) {
        localDomain = domain;
    }

    function setFailDispatch(
        bool enabled
    ) external {
        _failDispatch = enabled;
    }

    function quoteDispatch(
        uint32,
        bytes32,
        bytes calldata,
        bytes calldata metadata
    ) external pure returns (uint256) {
        require(metadata.length == 86 && uint256(bytes32(metadata[34:66])) == 200_000);
        return FEE;
    }

    function dispatch(
        uint32 destination_,
        bytes32 receiver_,
        bytes calldata body_,
        bytes calldata metadata
    ) external payable returns (bytes32 messageId) {
        if (_failDispatch) revert DispatchFailed();
        if (msg.value != FEE) revert WrongFee();
        require(metadata.length == 86 && uint256(bytes32(metadata[34:66])) == 200_000);

        destination = destination_;
        receiver = receiver_;
        sender = bytes32(uint256(uint160(msg.sender)));
        body = body_;
        messageId = keccak256(abi.encode(localDomain, destination_, receiver_, ++_nonce, body_));
    }

    function deliver(
        XTombShareBridge bridge,
        uint32 origin,
        bytes32 sender_,
        bytes memory body_
    ) external {
        bridge.handle(origin, sender_, body_);
    }
}

contract XTombShareBridgeTest is Test {
    uint32 private constant BASE = 8453;
    uint32 private constant BSC = 56;
    uint32 private constant PULSECHAIN = 369;
    uint32 private constant SONIC = 146;
    uint256 private constant ROUTE_LIMIT = 100 ether;
    uint256 private constant INITIAL_SHARES = 1000 ether;

    address private alice;
    address private bob;
    BridgeTestShare private share;
    BridgeTestISM private ism;
    BridgeTestMailbox private homeMailbox;
    XTombShareBridge private canonical;
    mapping(uint32 => XTombShareBridge) private satellite;
    mapping(uint32 => BridgeTestMailbox) private mailbox;

    function setUp() public {
        vm.chainId(BASE);
        alice = makeAddr("alice");
        bob = makeAddr("bob");
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);

        ism = new BridgeTestISM();
        _deployMesh(BASE);
    }

    function _deployMesh(
        uint32 home
    ) private {
        vm.chainId(home);
        share = new BridgeTestShare();
        homeMailbox = new BridgeTestMailbox(home);
        canonical = new XTombShareBridge(
            address(homeMailbox),
            address(ism),
            home,
            address(share),
            address(this),
            new XTombShareBridge.PeerConfig[](0)
        );

        share.mint(alice, INITIAL_SHARES);
        vm.prank(alice);
        share.approve(address(canonical), type(uint256).max);

        uint32[4] memory domains = _domains();
        for (uint256 i; i < domains.length; ++i) {
            if (domains[i] != home) _registerSatellite(home, domains[i]);
        }
    }

    /// Robinhood Chain (4663) is a Wizard chain choice only: never a route, never a home.
    function testRobinhoodChainIsNotABridgeRoute() public {
        vm.expectRevert(abi.encodeWithSelector(XTombShareBridge.InvalidRoute.selector, uint32(4663)));
        canonical.registerPeer(4663, address(canonical), ROUTE_LIMIT);

        vm.chainId(4663);
        BridgeTestMailbox hood = new BridgeTestMailbox(4663);
        vm.expectRevert(XTombShareBridge.InvalidConfiguration.selector);
        new XTombShareBridge(
            address(hood), address(ism), 4663, address(share), address(this), new XTombShareBridge.PeerConfig[](0)
        );
    }

    function testEveryDomainCanBeHomeAndRoundTripToEverySpoke() public {
        uint32[4] memory domains = _domains();
        for (uint256 i; i < domains.length; ++i) {
            uint32 home = domains[i];
            if (home != BASE) _deployMesh(home);
            _checkRoundTrips(home, domains);
        }
    }

    function _checkRoundTrips(
        uint32 home,
        uint32[4] memory domains
    ) private {
        assertTrue(canonical.isCanonical());
        assertEq(address(canonical.asset()), address(share));
        assertEq(canonical.localDomain(), home);
        assertEq(canonical.canonicalDomain(), home);
        assertEq(address(canonical.interchainSecurityModule()), address(ism));

        uint256 amount = 17 ether;
        for (uint256 i; i < domains.length; ++i) {
            uint32 domain = domains[i];
            if (domain == home) continue;
            XTombShareBridge remote = satellite[domain];
            assertFalse(remote.isCanonical());
            assertEq(remote.localDomain(), domain);
            assertEq(remote.canonicalDomain(), home);

            _enable(domain);
            _send(canonical, homeMailbox, domain, alice, bob, amount);
            assertEq(canonical.lockedFor(domain), amount);
            assertEq(share.balanceOf(address(canonical)), amount);
            assertEq(IERC20(address(remote.asset())).totalSupply(), 0);

            _relay(homeMailbox, mailbox[domain], remote);
            assertEq(IERC20(address(remote.asset())).balanceOf(bob), amount);

            _send(remote, mailbox[domain], home, bob, alice, amount);
            assertEq(IERC20(address(remote.asset())).totalSupply(), 0);
            assertEq(canonical.lockedFor(domain), amount);
            _relay(mailbox[domain], homeMailbox, canonical);
            assertEq(canonical.lockedFor(domain), 0);
            assertEq(share.balanceOf(address(canonical)), 0);
            assertEq(share.balanceOf(alice), INITIAL_SHARES);
            assertEq(share.totalSupply(), INITIAL_SHARES);
        }
    }

    function testFuzzPartialReturnConservesRouteBacking(
        uint96 rawAmount,
        uint96 rawReturn
    ) public {
        uint256 amount = bound(rawAmount, 1, ROUTE_LIMIT);
        uint256 returnAmount = bound(rawReturn, 1, amount);
        XTombShareBridge remote = satellite[SONIC];

        _enable(SONIC);
        _send(canonical, homeMailbox, SONIC, alice, bob, amount);
        _relay(homeMailbox, mailbox[SONIC], remote);
        _send(remote, mailbox[SONIC], BASE, bob, alice, returnAmount);
        _relay(mailbox[SONIC], homeMailbox, canonical);

        uint256 outstanding = amount - returnAmount;
        assertEq(canonical.lockedFor(SONIC), outstanding);
        assertEq(share.balanceOf(address(canonical)), outstanding);
        assertEq(IERC20(address(remote.asset())).totalSupply(), outstanding);
        assertEq(share.balanceOf(alice) + outstanding, INITIAL_SHARES);
    }

    function testOnlyOwnerCanConfigureAndRoutePeerCannotBeReplaced() public {
        vm.chainId(BASE);
        vm.prank(alice);
        vm.expectRevert();
        canonical.setOutboundEnabled(BSC, true);

        vm.expectRevert();
        canonical.registerPeer(BSC, alice, ROUTE_LIMIT);
    }

    function testRoutesStartDisabledAndCannotExceedLimit() public {
        vm.chainId(BASE);
        uint256 fee = homeMailbox.FEE();
        vm.prank(alice);
        vm.expectRevert();
        canonical.send{value: fee}(BSC, bob, 1 ether);
        assertEq(share.balanceOf(alice), INITIAL_SHARES);

        _enable(BSC);
        _send(canonical, homeMailbox, BSC, alice, bob, ROUTE_LIMIT);
        vm.prank(alice);
        vm.expectRevert();
        canonical.send{value: fee}(BSC, bob, 1);
        assertEq(canonical.lockedFor(BSC), ROUTE_LIMIT);
        assertEq(canonical.lockedFor(SONIC), 0);
    }

    function testSatelliteCannotRegisterAnotherSatellite() public {
        vm.chainId(BSC);
        vm.expectRevert();
        satellite[BSC].registerPeer(SONIC, address(satellite[SONIC]), ROUTE_LIMIT);
    }

    function testSendFailureRevertsEscrowAndFee() public {
        _enable(BSC);
        vm.chainId(BASE);
        homeMailbox.setFailDispatch(true);
        uint256 fee = homeMailbox.FEE();
        uint256 nativeBefore = alice.balance;
        vm.prank(alice);
        vm.expectRevert(BridgeTestMailbox.DispatchFailed.selector);
        canonical.send{value: fee}(BSC, bob, 1 ether);
        assertEq(canonical.lockedFor(BSC), 0);
        assertEq(share.balanceOf(alice), INITIAL_SHARES);
        assertEq(share.balanceOf(address(canonical)), 0);
        assertEq(alice.balance, nativeBefore);
    }

    function testWrongFeeAndFeeOnTransferCannotCreateUnbackedSupply() public {
        _enable(BSC);
        vm.chainId(BASE);
        uint256 fee = homeMailbox.FEE();

        vm.prank(alice);
        vm.expectRevert();
        canonical.send{value: fee - 1}(BSC, bob, 1 ether);

        vm.prank(alice);
        vm.expectRevert();
        canonical.send{value: fee + 1}(BSC, bob, 1 ether);

        share.setChargeFee(true);
        vm.prank(alice);
        vm.expectRevert();
        canonical.send{value: fee}(BSC, bob, 1 ether);

        assertEq(canonical.lockedFor(BSC), 0);
        assertEq(share.balanceOf(alice), INITIAL_SHARES);
        assertEq(share.balanceOf(address(canonical)), 0);
    }

    function testDirectSpoofAndWrongPeerAreRejected() public {
        vm.chainId(BSC);
        XTombShareBridge remote = satellite[BSC];
        bytes memory payload = abi.encode(bob, 1 ether, uint256(1));

        vm.prank(alice);
        vm.expectRevert();
        remote.handle(BASE, _encodePeer(address(canonical)), payload);

        vm.expectRevert();
        mailbox[BSC].deliver(remote, BASE, _encodePeer(alice), payload);

        vm.expectRevert();
        mailbox[BSC].deliver(remote, SONIC, _encodePeer(address(canonical)), payload);

        assertEq(IERC20(address(remote.asset())).totalSupply(), 0);
    }

    function testReplayAndModifiedMessageWithSameNonceAreRejected() public {
        _enable(BSC);
        XTombShareBridge remote = satellite[BSC];
        _send(canonical, homeMailbox, BSC, alice, bob, 1 ether);
        _relay(homeMailbox, mailbox[BSC], remote);
        bytes memory sent = homeMailbox.body();

        (,, uint256 nonce) = abi.decode(sent, (address, uint256, uint256));
        vm.expectRevert(abi.encodeWithSelector(XTombShareBridge.AlreadyReceived.selector, BASE, nonce));
        mailbox[BSC].deliver(remote, BASE, _encodePeer(address(canonical)), sent);

        bytes memory modified = abi.encode(alice, 2 ether, nonce);
        vm.expectRevert(abi.encodeWithSelector(XTombShareBridge.AlreadyReceived.selector, BASE, nonce));
        mailbox[BSC].deliver(remote, BASE, _encodePeer(address(canonical)), modified);

        assertEq(IERC20(address(remote.asset())).balanceOf(bob), 1 ether);
        assertEq(IERC20(address(remote.asset())).totalSupply(), 1 ether);
    }

    function testOneRouteCannotUnlockAnotherRoutesEscrow() public {
        _enable(BSC);
        _send(canonical, homeMailbox, BSC, alice, bob, 5 ether);
        bytes memory forgedReturn = abi.encode(bob, 1 ether, uint256(1));
        vm.chainId(BASE);

        vm.expectRevert();
        homeMailbox.deliver(canonical, SONIC, _encodePeer(address(satellite[SONIC])), forgedReturn);
        assertEq(canonical.lockedFor(SONIC), 0);
        assertEq(canonical.lockedFor(BSC), 5 ether);
        assertEq(share.balanceOf(address(canonical)), 5 ether);
        assertEq(share.balanceOf(bob), 0);
    }

    function testDisablingOutboundStillLetsInFlightTransferAndReturnComplete() public {
        _enable(BSC);
        XTombShareBridge remote = satellite[BSC];
        _send(canonical, homeMailbox, BSC, alice, bob, 5 ether);

        canonical.setOutboundEnabled(BSC, false);
        _relay(homeMailbox, mailbox[BSC], remote);
        _send(remote, mailbox[BSC], BASE, bob, alice, 5 ether);

        remote.setOutboundEnabled(BASE, false);
        _relay(mailbox[BSC], homeMailbox, canonical);
        assertEq(share.balanceOf(alice), INITIAL_SHARES);
        assertEq(canonical.lockedFor(BSC), 0);
        assertEq(IERC20(address(remote.asset())).totalSupply(), 0);
    }

    function testPausedInboundCanRetryTheSameMessageAfterUnpause() public {
        _enable(BSC);
        XTombShareBridge remote = satellite[BSC];
        _send(canonical, homeMailbox, BSC, alice, bob, 5 ether);
        bytes memory payload = homeMailbox.body();
        bytes32 sender = homeMailbox.sender();
        (,, uint256 nonce) = abi.decode(payload, (address, uint256, uint256));

        vm.chainId(BSC);
        vm.prank(alice);
        vm.expectRevert();
        remote.setInboundPaused(BASE, true);

        remote.setInboundPaused(BASE, true);
        assertTrue(remote.inboundPaused(BASE));
        vm.expectRevert();
        mailbox[BSC].deliver(remote, BASE, sender, payload);
        assertFalse(remote.received(BASE, nonce));
        assertEq(IERC20(remote.asset()).totalSupply(), 0);

        remote.setInboundPaused(BASE, false);
        mailbox[BSC].deliver(remote, BASE, sender, payload);
        assertTrue(remote.received(BASE, nonce));
        assertEq(IERC20(remote.asset()).balanceOf(bob), 5 ether);
    }

    function testCanonicalReturnRetriesAfterTransferFailure() public {
        _enable(BSC);
        XTombShareBridge remote = satellite[BSC];
        _send(canonical, homeMailbox, BSC, alice, bob, 5 ether);
        _relay(homeMailbox, mailbox[BSC], remote);
        _send(remote, mailbox[BSC], BASE, bob, alice, 5 ether);
        bytes memory payload = mailbox[BSC].body();
        bytes32 sender = mailbox[BSC].sender();
        (,, uint256 nonce) = abi.decode(payload, (address, uint256, uint256));

        vm.chainId(BASE);
        share.setChargeFee(true);
        vm.expectRevert(XTombShareBridge.InvalidTokenDelta.selector);
        homeMailbox.deliver(canonical, BSC, sender, payload);
        assertFalse(canonical.received(BSC, nonce));
        assertEq(canonical.lockedFor(BSC), 5 ether);
        assertEq(share.balanceOf(address(canonical)), 5 ether);

        share.setChargeFee(false);
        homeMailbox.deliver(canonical, BSC, sender, payload);
        assertTrue(canonical.received(BSC, nonce));
        assertEq(canonical.lockedFor(BSC), 0);
        assertEq(share.balanceOf(alice), INITIAL_SHARES);
    }

    function testOnlyBridgeCanMintOrBurnWrappedTokens() public {
        _enable(BSC);
        XTombShareBridge remote = satellite[BSC];
        _send(canonical, homeMailbox, BSC, alice, bob, 1 ether);
        _relay(homeMailbox, mailbox[BSC], remote);

        XTombBridgedShare wrapped = XTombBridgedShare(remote.asset());
        vm.expectRevert(XTombBridgedShare.OnlyBridge.selector);
        wrapped.bridgeMint(alice, 1 ether);
        vm.expectRevert(XTombBridgedShare.OnlyBridge.selector);
        wrapped.bridgeBurn(bob, 1 ether);
        assertEq(wrapped.balanceOf(bob), 1 ether);
    }

    function _registerSatellite(
        uint32 home,
        uint32 domain
    ) private {
        vm.chainId(domain);
        BridgeTestMailbox remoteMailbox = new BridgeTestMailbox(domain);
        address expected = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        XTombBridgedShare token = new XTombBridgedShare(expected);
        XTombShareBridge.PeerConfig[] memory peers = new XTombShareBridge.PeerConfig[](1);
        peers[0] = XTombShareBridge.PeerConfig(home, address(canonical), ROUTE_LIMIT);
        XTombShareBridge remote =
            new XTombShareBridge(address(remoteMailbox), address(ism), home, address(token), address(this), peers);
        assertEq(address(remote), expected);

        satellite[domain] = remote;
        mailbox[domain] = remoteMailbox;

        vm.chainId(home);
        canonical.registerPeer(domain, address(remote), ROUTE_LIMIT);
    }

    function _enable(
        uint32 domain
    ) private {
        uint32 home = canonical.localDomain();
        vm.chainId(home);
        canonical.setOutboundEnabled(domain, true);
        vm.chainId(domain);
        satellite[domain].setOutboundEnabled(home, true);
        vm.chainId(home);
    }

    function _send(
        XTombShareBridge bridge,
        BridgeTestMailbox sourceMailbox,
        uint32 destination,
        address from,
        address to,
        uint256 amount
    ) private {
        vm.chainId(sourceMailbox.localDomain());
        uint256 fee = bridge.quoteSend(destination, to, amount);
        assertEq(fee, sourceMailbox.FEE());
        vm.prank(from);
        bytes32 messageId = bridge.send{value: fee}(destination, to, amount);
        assertTrue(messageId != bytes32(0));
    }

    function _relay(
        BridgeTestMailbox source,
        BridgeTestMailbox destination,
        XTombShareBridge bridge
    ) private {
        vm.chainId(destination.localDomain());
        assertEq(source.destination(), destination.localDomain());
        assertEq(source.receiver(), _encodePeer(address(bridge)));
        destination.deliver(bridge, source.localDomain(), source.sender(), source.body());
    }

    function _domains() private pure returns (uint32[4] memory) {
        return [BASE, BSC, PULSECHAIN, SONIC];
    }

    function _encodePeer(
        address peer
    ) private pure returns (bytes32) {
        return bytes32(uint256(uint160(peer)));
    }
}
