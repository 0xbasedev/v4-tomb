// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Mint authority for X Tomb (LEVEL). Implemented by the dry-run
/// LaunchLevel mock and by any production peg token whose operator is the
/// Masonry Treasury.
interface IMasonryMintableLevel is IERC20 {
    function mint(
        address to,
        uint256 amount
    ) external;
}

/// @notice Stake room that receives epoch expansion. `totalSupply` is the
/// staked X Share/WETH LP amount used for the empty-Masonry skip.
interface IMasonrySeigniorageSink {
    function totalSupply() external view returns (uint256);
    function allocateSeigniorage(
        uint256 amount
    ) external;
}

/// @notice Treasury callback used by MasonryBond to pay redemptions.
interface IMasonryBondSettler {
    function settleBondRedemption(
        address to,
        uint256 tombAmount
    ) external;
}
