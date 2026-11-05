// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/**
 * @title Addresses
 * @notice Per-chain canonical contract addresses used by Old Money deploys.
 *
 *         - V4 PoolManager (real, from developers.uniswap.org/contracts/v4/deployments)
 *         - WETH (canonical wrapped ETH; pre-deployed on every OP-stack chain at
 *           the predeploy slot 0x4200...0006; canonical 0xC02a... on Ethereum mainnet;
 *           etc.)
 *
 *         Old Money pegs $MONEY 1:1 to WETH (1 MONEY = 1 ETH at parity). WETH is
 *         available on every supported chain — no mock needed on testnets, which
 *         is a deliberate improvement over the prior cbETH peg (cbETH was Coinbase-
 *         issued only on mainnet chains, forcing a `MockCbeth` shim on testnets).
 *
 *         Verified 2026-05-22. See memory/reference_v4_deployments.md for sources.
 */
library HistoricalAddresses {
    uint256 internal constant ETHEREUM_MAINNET = 1;
    uint256 internal constant BASE_MAINNET = 8453;
    uint256 internal constant BASE_SEPOLIA = 84_532;
    uint256 internal constant ETHEREUM_SEPOLIA = 11_155_111;
    uint256 internal constant OPTIMISM = 10;
    uint256 internal constant ARBITRUM = 42_161;
    uint256 internal constant POLYGON = 137;
    uint256 internal constant UNICHAIN = 130;

    error UnsupportedChain(uint256 chainId);

    /// @notice V4 PoolManager for the current chain.
    function poolManager() internal view returns (address) {
        uint256 cid = block.chainid;
        if (cid == ETHEREUM_MAINNET) return 0x000000000004444c5dc75cB358380D2e3dE08A90;
        if (cid == BASE_MAINNET) return 0x498581fF718922c3f8e6A244956aF099B2652b2b;
        if (cid == BASE_SEPOLIA) return 0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408;
        if (cid == ETHEREUM_SEPOLIA) return 0xE03A1074c86CFeDd5C142C4F04F1a1536e203543;
        if (cid == OPTIMISM) return 0x9a13F98Cb987694C9F086b1F5eB990EeA8264Ec3;
        if (cid == ARBITRUM) return 0x360E68faCcca8cA495c1B759Fd9EEe466db9FB32;
        if (cid == POLYGON) return 0x67366782805870060151383F4BbFF9daB53e5cD6;
        if (cid == UNICHAIN) return 0x1F98400000000000000000000000000000000004;
        revert UnsupportedChain(cid);
    }

    /// @notice V4 PositionManager for the current chain. Source:
    ///         developers.uniswap.org/contracts/v4/deployments (verified 2026-05-22).
    function positionManager() internal view returns (address) {
        uint256 cid = block.chainid;
        if (cid == ETHEREUM_MAINNET) return 0xbD216513d74C8cf14cf4747E6AaA6420FF64ee9e;
        if (cid == BASE_MAINNET) return 0x7C5f5A4bBd8fD63184577525326123B519429bDc;
        if (cid == BASE_SEPOLIA) return 0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80;
        if (cid == ETHEREUM_SEPOLIA) return 0x429ba70129df741B2Ca2a85BC3A2a3328e5c09b4;
        if (cid == OPTIMISM) return 0x3C3Ea4B57a46241e54610e5f022E5c45859A1017;
        if (cid == ARBITRUM) return 0xd88F38F930b7952f2DB2432Cb002E7abbF3dD869;
        if (cid == POLYGON) return 0x1Ec2eBf4F37E7363FDfe3551602425af0B3ceef9;
        if (cid == UNICHAIN) return 0x4529A01c7A0410167c5740C487A8DE60232617bf;
        revert UnsupportedChain(cid);
    }

    /// @notice Canonical Permit2 deployment. Same address on every chain.
    function permit2() internal pure returns (address) {
        return 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    }

    /// @notice WETH for the current chain. Canonical wrapped ETH:
    ///         - OP-stack chains (Base, Base Sepolia, Optimism, Unichain) use the
    ///           predeploy at 0x4200...0006
    ///         - Ethereum mainnet uses Wrapped Ether at 0xC02a...756Cc2
    ///         - Other chains use their canonical WETH9 deployment
    function weth() internal view returns (address) {
        uint256 cid = block.chainid;
        if (cid == ETHEREUM_MAINNET) return 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
        if (cid == BASE_MAINNET) return 0x4200000000000000000000000000000000000006;
        if (cid == BASE_SEPOLIA) return 0x4200000000000000000000000000000000000006;
        if (cid == ETHEREUM_SEPOLIA) return 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;
        if (cid == OPTIMISM) return 0x4200000000000000000000000000000000000006;
        if (cid == ARBITRUM) return 0x82aF49447D8a07e3bd95BD0d56f35241523fBab1;
        if (cid == POLYGON) return 0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619;
        if (cid == UNICHAIN) return 0x4200000000000000000000000000000000000006;
        revert UnsupportedChain(cid);
    }
}
