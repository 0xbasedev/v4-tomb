// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/**
 * @title Addresses
 * @notice Per-chain canonical contract addresses used by Old Money deploys.
 *
 *         The library returns deterministic addresses for the chain it's called on:
 *         - V4 PoolManager (real, from developers.uniswap.org/contracts/v4/deployments)
 *         - cbETH (real on mainnet chains where Coinbase deploys it; reverts on
 *           testnets — caller is expected to deploy a mock cbETH there)
 *
 *         Verified 2026-05-22. See memory/reference_v4_deployments.md for the source.
 */
library Addresses {
    uint256 internal constant ETHEREUM_MAINNET = 1;
    uint256 internal constant BASE_MAINNET = 8453;
    uint256 internal constant BASE_SEPOLIA = 84_532;
    uint256 internal constant ETHEREUM_SEPOLIA = 11_155_111;
    uint256 internal constant OPTIMISM = 10;
    uint256 internal constant ARBITRUM = 42_161;
    uint256 internal constant POLYGON = 137;
    uint256 internal constant UNICHAIN = 130;

    error UnsupportedChain(uint256 chainId);
    error CbethNotOnChain(uint256 chainId);

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

    /// @notice cbETH for the current chain. Reverts on chains where Coinbase has not
    ///         deployed cbETH (notably all testnets) — caller deploys a mock.
    function cbeth() internal view returns (address) {
        uint256 cid = block.chainid;
        if (cid == ETHEREUM_MAINNET) return 0xBe9895146f7AF43049ca1c1AE358B0541Ea49704;
        if (cid == BASE_MAINNET) return 0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22;
        if (cid == OPTIMISM) return 0xadDb6A0412DE1BA0F936DCaeb8Aaa24578dcF3B2;
        revert CbethNotOnChain(cid);
    }

    /// @notice True iff the chain has a real Coinbase-deployed cbETH.
    function hasCbeth() internal view returns (bool) {
        uint256 cid = block.chainid;
        return cid == ETHEREUM_MAINNET || cid == BASE_MAINNET || cid == OPTIMISM;
    }
}
