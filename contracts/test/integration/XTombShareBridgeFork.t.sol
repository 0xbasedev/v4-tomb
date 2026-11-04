// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
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

contract XTombShareBridgeForkTest is Test {
    uint32 private constant BASE = 8453;
    bytes32 private constant DISPATCH = keccak256("Dispatch(address,uint32,bytes32,bytes)");

    function testForkRealMailboxesAcrossFiveChains() external {
        vm.skip(!vm.envOr("XSHARE_BRIDGE_FORKS", false));

        string memory config = vm.readFile("../config/xshare-bridge.json");
        address baseMailbox = vm.parseJsonAddress(config, ".networks[0].mailbox");
        uint256 baseFork = vm.createSelectFork(vm.parseJsonString(config, ".networks[0].rpcUrl"));
        BridgeForkShare share = new BridgeForkShare();
        XTombShareBridge home =
            new XTombShareBridge(baseMailbox, address(new BridgeForkISM()), BASE, address(share), address(this));
        share.approve(address(home), type(uint256).max);
        vm.deal(address(this), 10 ether);

        for (uint256 i = 1; i < 5; ++i) {
            string memory network = string.concat(".networks[", vm.toString(i), "]");
            address remoteMailbox = vm.parseJsonAddress(config, string.concat(network, ".mailbox"));
            uint256 remoteFork = vm.createSelectFork(vm.parseJsonString(config, string.concat(network, ".rpcUrl")));
            BridgeForkISM verifier = new BridgeForkISM();
            XTombShareBridge remote =
                new XTombShareBridge(remoteMailbox, address(verifier), BASE, address(0), address(this));
            uint32 domain = remote.localDomain();
            remote.registerPeer(BASE, address(home), 10 ether);
            remote.setOutboundEnabled(BASE, true);
            vm.deal(address(this), 1_000_000 ether);

            vm.selectFork(baseFork);
            home.registerPeer(domain, address(remote), 10 ether);
            home.setOutboundEnabled(domain, true);
            bytes memory outward = _send(home, domain);
            assertEq(home.lockedFor(domain), 1 ether);

            vm.selectFork(remoteFork);
            verifier.setAccept(false);
            vm.expectRevert();
            IForkMailbox(remoteMailbox).process("", outward);
            verifier.setAccept(true);
            IForkMailbox(remoteMailbox).process("", outward);
            assertEq(ERC20(remote.asset()).balanceOf(address(this)), 1 ether);
            bytes memory returning = _send(remote, BASE);
            assertEq(ERC20(remote.asset()).totalSupply(), 0);

            vm.selectFork(baseFork);
            IForkMailbox(baseMailbox).process("", returning);
            assertEq(home.lockedFor(domain), 0);
            assertEq(share.balanceOf(address(this)), 100 ether);
        }
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
