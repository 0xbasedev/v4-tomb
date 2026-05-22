// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.26;

/**
 * @title IBasisAsset
 * @notice Tomb-shape interface for any "basis asset" — a token whose mint/burn authority sits
 *         with a single operator (the Treasury). Implemented by OldMoney, Estate, and
 *         TrustNote via the [[Trustees]] base contract's operator()/isOperator()/transferOperator
 *         aliases.
 */
interface IBasisAsset {
    function mint(
        address recipient,
        uint256 amount
    ) external returns (bool);
    function burn(
        uint256 amount
    ) external;
    function burnFrom(
        address from,
        uint256 amount
    ) external;

    function isOperator() external returns (bool);
    function operator() external view returns (address);
    function transferOperator(
        address newOperator_
    ) external;
}
