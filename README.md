# Old Money — $OLDM

An algorithmic stable on Base, pegged to cbETH. Fork of Tomb Finance, modernized for Solidity 0.8.26, OpenZeppelin v5, and Uniswap V4 hooks.

> Premium. Sustainable. Old Money.

## Status

Pre-alpha. Scaffolding complete, no production contracts yet.

## Stack

- **Contracts**: Foundry, Solidity 0.8.26, OpenZeppelin v5.4.0, Solady, Uniswap V4 core + periphery
- **Frontend** (TBD): Vite + React + Viem + Wagmi + Tailwind
- **Chain**: Base mainnet (8453), Base Sepolia (84532)

## Layout

```
oldMoney/
├── contracts/          Foundry workspace — see contracts/README.md (TBD)
├── frontend/           React + Viem + Wagmi (TBD)
├── docs/               Architecture, peg mechanics, hook design (TBD)
└── .github/workflows/  CI pipelines
```

## Quick start

```bash
# clone, then:
cd contracts
forge install OpenZeppelin/openzeppelin-contracts@v5.4.0 --no-git
forge install Vectorized/solady --no-git
forge install Uniswap/v4-core --no-git
forge install Uniswap/v4-periphery --no-git
forge build
forge test
```

## Token glossary

| Brand name | Tomb analog | Role |
|---|---|---|
| `$OLDM` (OldMoney) | TOMB | Algorithmic stable, pegged to 1 cbETH |
| `$ESTATE` (Estate) | TSHARE | Share / governance / fee accrual |
| `$TRUSTNOTE` (TrustNote) | TBOND | Contraction bond, redeemed during expansion |

## Contract glossary (themed → Tomb analog)

| Themed | Tomb analog |
|---|---|
| `Trustees` | Treasury |
| `TheClub` | Boardroom |
| `TheVault` | Cemetery (staking pools) |
| `PegDefenseHook` | (new — Uniswap V4 hook) |

NatSpec headers on each contract document the original Tomb mechanism for auditors.

## License

TBD (likely MIT or BUSL-1.1, pending decision).
