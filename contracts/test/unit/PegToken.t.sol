// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

import {BaseTest} from "../utils/BaseTest.sol";
import {PegToken} from "../../src/tokens/PegToken.sol";
import {Trustees} from "../../src/governance/Trustees.sol";

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MockERC20 is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(
        address to,
        uint256 amount
    ) external {
        _mint(to, amount);
    }
}

contract PegTokenTest is BaseTest {
    PegToken internal peg;

    address internal genesisPool = makeAddr("genesisPool");
    address internal mainPool = makeAddr("mainPool");
    address internal airdropWallet = makeAddr("airdropWallet");

    event TrusteesTransferred(address indexed previousTrustees, address indexed newTrustees);
    event Coined(address indexed to, uint256 amount);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event RewardPoolDistributed(address indexed genesisPool, address indexed mainPool, address indexed airdropWallet);
    event UnsupportedTokenRecovered(IERC20 indexed token, uint256 amount, address indexed to);

    function setUp() public override {
        super.setUp();
        vm.label(genesisPool, "genesisPool");
        vm.label(mainPool, "mainPool");
        vm.label(airdropWallet, "airdropWallet");

        // Deploy from `owner` so owner is initial owner + initial trustees.
        vm.prank(owner);
        peg = new PegToken();

        // Rotate trustees to the dedicated `trustees` actor.
        vm.prank(owner);
        peg.transferTrustees(trustees);
    }

    // ---------------------------------------------------------------------
    // Constructor / metadata
    // ---------------------------------------------------------------------

    function test_Metadata() public view {
        assertEq(peg.name(), "LEVEL");
        assertEq(peg.symbol(), "LEVEL");
        assertEq(peg.decimals(), 18);
    }

    function test_Constructor_OwnerAndInitialDeployerMint() public {
        // Re-deploy fresh to inspect the constructor effects directly.
        vm.prank(alice);
        PegToken fresh = new PegToken();
        assertEq(fresh.owner(), alice);
        // 1 unit minted to the deployer for initial LP / sanity.
        assertEq(fresh.balanceOf(alice), 1 ether);
        assertEq(fresh.totalSupply(), 1 ether);
        // Trustees defaults to the deployer until rotated.
        assertEq(fresh.trustees(), alice);
        assertFalse(fresh.rewardPoolDistributed());
    }

    // ---------------------------------------------------------------------
    // Trustees rotation
    // ---------------------------------------------------------------------

    function test_TransferTrustees_OnlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        peg.transferTrustees(alice);
    }

    function test_TransferTrustees_RejectsZero() public {
        vm.prank(owner);
        vm.expectRevert(Trustees.ZeroTrusteesAddress.selector);
        peg.transferTrustees(address(0));
    }

    function test_TransferTrustees_EmitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit TrusteesTransferred(trustees, alice);
        vm.prank(owner);
        peg.transferTrustees(alice);
        assertEq(peg.trustees(), alice);
    }

    function test_IsTrustees_TrueForTrustees() public {
        vm.prank(trustees);
        assertTrue(peg.isTrustees());
    }

    function test_IsTrustees_FalseForNonTrustees() public {
        vm.prank(stranger);
        assertFalse(peg.isTrustees());
    }

    // ---------------------------------------------------------------------
    // mint() — Tomb signature, returns bool
    // ---------------------------------------------------------------------

    function test_Mint_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        peg.mint(alice, 1 ether);
    }

    function test_Mint_OwnerCannotMint() public {
        vm.prank(owner);
        vm.expectRevert(Trustees.NotTrustees.selector);
        peg.mint(alice, 1 ether);
    }

    function test_Mint_ReturnsTrueOnPositiveAmount() public {
        vm.prank(trustees);
        bool ok = peg.mint(alice, 1 ether);
        assertTrue(ok);
        assertEq(peg.balanceOf(alice), 1 ether);
    }

    function test_Mint_ReturnsFalseOnZeroAmount() public {
        vm.prank(trustees);
        bool ok = peg.mint(alice, 0);
        assertFalse(ok);
        assertEq(peg.balanceOf(alice), 0);
    }

    function test_Mint_EmitsCoinedAndTransfer() public {
        vm.expectEmit(true, true, true, true);
        emit Transfer(address(0), alice, 1 ether);
        vm.expectEmit(true, true, true, true);
        emit Coined(alice, 1 ether);

        vm.prank(trustees);
        peg.mint(alice, 1 ether);
    }

    // ---------------------------------------------------------------------
    // burn / burnFrom (Tomb-faithful: trustees-restricted burnFrom)
    // ---------------------------------------------------------------------

    function test_Burn_HolderCanBurnOwnBalance() public {
        vm.prank(trustees);
        peg.mint(alice, 5 ether);
        vm.prank(alice);
        peg.burn(2 ether);
        assertEq(peg.balanceOf(alice), 3 ether);
    }

    function test_BurnFrom_OnlyTrustees() public {
        vm.prank(trustees);
        peg.mint(alice, 5 ether);
        vm.prank(alice);
        peg.approve(bob, 5 ether);

        // bob has allowance, but bob is not trustees — burnFrom must revert.
        vm.prank(bob);
        vm.expectRevert(Trustees.NotTrustees.selector);
        peg.burnFrom(alice, 1 ether);
    }

    function test_BurnFrom_TrusteesNeedsAllowance() public {
        vm.prank(trustees);
        peg.mint(alice, 5 ether);

        // Without an allowance, trustees still cannot burnFrom.
        vm.prank(trustees);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, trustees, 0, 1 ether));
        peg.burnFrom(alice, 1 ether);

        // With allowance, trustees can burnFrom.
        vm.prank(alice);
        peg.approve(trustees, 1 ether);
        vm.prank(trustees);
        peg.burnFrom(alice, 1 ether);
        assertEq(peg.balanceOf(alice), 4 ether);
    }

    // ---------------------------------------------------------------------
    // distributeReward — one-shot Tomb-style genesis
    // ---------------------------------------------------------------------

    function test_DistributeReward_OnlyTrustees() public {
        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        peg.distributeReward(genesisPool, mainPool, airdropWallet);
    }

    function test_DistributeReward_RejectsZeroGenesis() public {
        vm.prank(trustees);
        vm.expectRevert(PegToken.ZeroAddress.selector);
        peg.distributeReward(address(0), mainPool, airdropWallet);
    }

    function test_DistributeReward_RejectsZeroMain() public {
        vm.prank(trustees);
        vm.expectRevert(PegToken.ZeroAddress.selector);
        peg.distributeReward(genesisPool, address(0), airdropWallet);
    }

    function test_DistributeReward_RejectsZeroAirdrop() public {
        vm.prank(trustees);
        vm.expectRevert(PegToken.ZeroAddress.selector);
        peg.distributeReward(genesisPool, mainPool, address(0));
    }

    function test_DistributeReward_MintsExactAllocations() public {
        vm.prank(trustees);
        peg.distributeReward(genesisPool, mainPool, airdropWallet);

        assertEq(peg.balanceOf(genesisPool), peg.INITIAL_GENESIS_POOL_DISTRIBUTION());
        assertEq(peg.balanceOf(mainPool), peg.INITIAL_MAIN_POOL_DISTRIBUTION());
        assertEq(peg.balanceOf(airdropWallet), peg.INITIAL_AIRDROP_WALLET_DISTRIBUTION());

        // The 1 ether deploy seed + 11k + 140k + 9k.
        uint256 expectedSupply = 1 ether + 11_000 ether + 140_000 ether + 9000 ether;
        assertEq(peg.totalSupply(), expectedSupply);
        assertTrue(peg.rewardPoolDistributed());
    }

    function test_DistributeReward_EmitsEvent() public {
        vm.expectEmit(true, true, true, true);
        emit RewardPoolDistributed(genesisPool, mainPool, airdropWallet);
        vm.prank(trustees);
        peg.distributeReward(genesisPool, mainPool, airdropWallet);
    }

    function test_DistributeReward_OneShot() public {
        vm.prank(trustees);
        peg.distributeReward(genesisPool, mainPool, airdropWallet);

        vm.prank(trustees);
        vm.expectRevert(PegToken.AlreadyDistributed.selector);
        peg.distributeReward(genesisPool, mainPool, airdropWallet);
    }

    // ---------------------------------------------------------------------
    // governanceRecoverUnsupported — stuck-token rescue
    // ---------------------------------------------------------------------

    function test_GovernanceRecoverUnsupported_OnlyTrustees() public {
        MockERC20 stuck = new MockERC20();
        stuck.mint(address(peg), 100 ether);

        vm.prank(stranger);
        vm.expectRevert(Trustees.NotTrustees.selector);
        peg.governanceRecoverUnsupported(IERC20(address(stuck)), 100 ether, alice);
    }

    function test_GovernanceRecoverUnsupported_TransfersStuckTokens() public {
        MockERC20 stuck = new MockERC20();
        stuck.mint(address(peg), 100 ether);

        vm.expectEmit(true, true, true, true);
        emit UnsupportedTokenRecovered(IERC20(address(stuck)), 100 ether, alice);
        vm.prank(trustees);
        peg.governanceRecoverUnsupported(IERC20(address(stuck)), 100 ether, alice);

        assertEq(stuck.balanceOf(alice), 100 ether);
        assertEq(stuck.balanceOf(address(peg)), 0);
    }

    // ---------------------------------------------------------------------
    // Ownable2Step
    // ---------------------------------------------------------------------

    function test_OwnershipTransfer_TwoStep() public {
        vm.prank(owner);
        peg.transferOwnership(alice);
        assertEq(peg.owner(), owner);
        assertEq(peg.pendingOwner(), alice);

        vm.prank(alice);
        peg.acceptOwnership();
        assertEq(peg.owner(), alice);
        assertEq(peg.pendingOwner(), address(0));
    }

    // ---------------------------------------------------------------------
    // EIP-2612 Permit — kept as an approved additive modernization
    // ---------------------------------------------------------------------

    function test_Permit_GaslessApproval() public {
        (uint256 pk, address holder) = _makeSigner("permit_holder");

        vm.prank(trustees);
        peg.mint(holder, 10 ether);

        uint256 nonce = peg.nonces(holder);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 value = 5 ether;
        address spender = bob;

        bytes32 typehash =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash = keccak256(abi.encode(typehash, holder, spender, value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", peg.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        peg.permit(holder, spender, value, deadline, v, r, s);

        assertEq(peg.allowance(holder, spender), value);
        assertEq(peg.nonces(holder), nonce + 1);
    }

    // ---------------------------------------------------------------------
    // Fuzz
    // ---------------------------------------------------------------------

    function testFuzz_Mint_IncreasesSupplyByExactly(
        uint96 amount
    ) public {
        uint256 supplyBefore = peg.totalSupply();
        vm.prank(trustees);
        peg.mint(alice, amount);
        assertEq(peg.totalSupply(), supplyBefore + amount);
        assertEq(peg.balanceOf(alice), amount);
    }

    function testFuzz_Burn_DecreasesSupplyByExactly(
        uint96 mintAmount,
        uint96 burnAmount
    ) public {
        vm.assume(burnAmount <= mintAmount);
        uint256 supplyBefore = peg.totalSupply();
        vm.prank(trustees);
        peg.mint(alice, mintAmount);
        vm.prank(alice);
        peg.burn(burnAmount);
        assertEq(peg.totalSupply(), supplyBefore + uint256(mintAmount) - uint256(burnAmount));
    }
}
