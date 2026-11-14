// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {XTombBridgedShare} from "../../src/bridge/XTombBridgedShare.sol";
import {Create3Config} from "../../script/Create3Config.s.sol";
import {XTombShareBridge} from "../../src/bridge/XTombShareBridge.sol";

interface IForkMailbox {
    function process(
        bytes calldata metadata,
        bytes calldata message
    ) external payable;
}

/// @dev Test-only verifier. Forks exercise the real Mailbox and hooks without validator credentials.
contract BridgeForkISM {
    bool private _accept = true;

    function setAccept(
        bool accept
    ) external {
        _accept = accept;
    }

    function moduleType() external pure returns (uint8) {
        return 6;
    }

    function verify(
        bytes calldata,
        bytes calldata
    ) external view returns (bool) {
        return _accept;
    }
}

contract BridgeForkShare is ERC20 {
    constructor() ERC20("Fork xSHARE", "xSHARE") {
        _mint(msg.sender, 100 ether);
    }
}

contract XTombShareBridgeForkTest is Test, Create3Config {
    uint32 private constant BASE = 8453;
    bytes32 private constant DISPATCH = keccak256("Dispatch(address,uint32,bytes32,bytes)");

    struct Home {
        uint256 forkId;
        XTombShareBridge bridge;
        BridgeForkShare token;
    }

    function testForkRealMailboxesAcrossFourChains() external {
        vm.skip(!vm.envOr("XSHARE_BRIDGE_FORKS", false));

        string memory config = vm.readFile("../config/xshare-bridge.json");
        Create3Plan memory plan = Create3Plan(CREATEX, address(this), keccak256("xshare-fork"));
        Home memory home;
        home.forkId = vm.createSelectFork(vm.parseJsonString(config, ".networks[0].rpcUrl"));
        home.token = new BridgeForkShare();
        home.bridge = _deployBridge(
            plan,
            vm.parseJsonAddress(config, ".networks[0].mailbox"),
            new BridgeForkISM(),
            address(home.token),
            new XTombShareBridge.PeerConfig[](0)
        );
        home.token.approve(address(home.bridge), type(uint256).max);
        vm.deal(address(this), 10 ether);

        for (uint256 i = 1; i < 4; ++i) {
            _roundTrip(plan, config, string.concat(".networks[", vm.toString(i), "]"), home);
        }
    }

    function _roundTrip(
        Create3Plan memory plan,
        string memory config,
        string memory path,
        Home memory home
    ) private {
        address mailbox = vm.parseJsonAddress(config, string.concat(path, ".mailbox"));
        uint256 forkId = vm.createSelectFork(vm.parseJsonString(config, string.concat(path, ".rpcUrl")));
        BridgeForkISM verifier = new BridgeForkISM();
        address token = _deployCreate3(
            plan,
            "bridgedShare",
            0,
            _create3Address(plan, "bridgedShare", 0),
            abi.encodePacked(type(XTombBridgedShare).creationCode, abi.encode(address(home.bridge)))
        );
        XTombShareBridge.PeerConfig[] memory peers = new XTombShareBridge.PeerConfig[](1);
        peers[0] = XTombShareBridge.PeerConfig(BASE, address(home.bridge), 10 ether);
        XTombShareBridge remote = _deployBridge(plan, mailbox, verifier, token, peers);
        remote.setOutboundEnabled(BASE, true);
        vm.deal(address(this), 1_000_000 ether);

        vm.selectFork(home.forkId);
        uint32 domain = uint32(vm.parseJsonUint(config, string.concat(path, ".domain")));
        home.bridge.registerPeer(domain, address(remote), 10 ether);
        home.bridge.setOutboundEnabled(domain, true);
        bytes memory outward = _send(home.bridge, domain);
        assertEq(home.bridge.lockedFor(domain), 1 ether);

        vm.selectFork(forkId);
        verifier.setAccept(false);
        vm.expectRevert();
        IForkMailbox(mailbox).process("", outward);
        verifier.setAccept(true);
        IForkMailbox(mailbox).process("", outward);
        assertEq(ERC20(token).balanceOf(address(this)), 1 ether);
        bytes memory returning = _send(remote, BASE);
        assertEq(ERC20(token).totalSupply(), 0);

        vm.selectFork(home.forkId);
        IForkMailbox(address(home.bridge.mailbox())).process("", returning);
        assertEq(home.bridge.lockedFor(domain), 0);
        assertEq(home.token.balanceOf(address(this)), 100 ether);
    }

    function _deployBridge(
        Create3Plan memory plan,
        address mailbox,
        BridgeForkISM verifier,
        address token,
        XTombShareBridge.PeerConfig[] memory peers
    ) private returns (XTombShareBridge) {
        assertEq(plan.factory.codehash, CREATEX_CODE_HASH);
        return XTombShareBridge(
            _deployCreate3(
                plan,
                "xshareBridge",
                0,
                _create3Address(plan, "xshareBridge", 0),
                abi.encodePacked(
                    type(XTombShareBridge).creationCode,
                    abi.encode(mailbox, verifier, BASE, token, address(this), peers)
                )
            )
        );
    }

    function _send(
        XTombShareBridge bridge,
        uint32 domain
    ) private returns (bytes memory) {
        uint256 fee = bridge.quoteSend(domain, address(this), 1 ether);
        vm.recordLogs();
        bytes32 id = bridge.send{value: fee}(domain, address(this), 1 ether);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(bridge.mailbox()) && logs[i].topics[0] == DISPATCH) {
                bytes memory message = abi.decode(logs[i].data, (bytes));
                assertEq(keccak256(message), id);
                return message;
            }
        }
        revert("Missing Mailbox dispatch");
    }
}
