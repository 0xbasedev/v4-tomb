# Old Money

> An algorithmic-stable protocol on Base. `$MONEY` pegged 1:1 to Ether, defended by a Uniswap V4 hook and a seigniorage Treasury. `$ESTATE` stakers earn each expansion epoch; `$TRUSTNOTE` bondholders speculate on recovery.

A Tomb-faithful port of the Tomb Finance economic engine, modernized for Solidity 0.8.26, OpenZeppelin v5, and Uniswap V4. Branded in an Art Deco voice ("The Trust", "The Club", "The Vault", "Trust Notes", "The Exchange"). Deployed on Base Sepolia; mainnet pending audit + governance rotation.

```
   ┌─────────────────────────────────────────────┐
   │   The Trust · MMXXVI · Engineered with Precision   │
   └─────────────────────────────────────────────┘
```

## Status

| Surface | State |
|---|---|
| Contracts | Deployed to Base Sepolia, frozen API for audit handoff |
| Tests | 356 / 0 — unit + integration + Base mainnet fork + invariant |
| Invariants | 42 properties, audit profile (10,000 × 200 fuzz) all green |
| Static analysis | Slither 0 medium+ findings (12 MasterChef false positives triaged) |
| Frontend | Wired end-to-end against Base Sepolia, every read live, every write tested |
| Audit | Handoff doc ready at [`docs/AUDIT_HANDOFF.md`](docs/AUDIT_HANDOFF.md) |
| Mainnet | Pending audit + governance rotation |

## Three Estates

| Token | Role | Where it comes from |
|---|---|---|
| `$MONEY` | The stable — pegged 1 MONEY = 1 WETH. Used as collateral, in swaps, burned for Notes. | Pre-distributed to Genesis / Main reward pools + airdrop; minted by Treasury during expansion epochs. |
| `$ESTATE` | The share — hard-capped at 70,000. Stake at The Club to receive a cut of every expansion. | Earned from the Share Reward Pool over 370 days for MONEY-WETH LPs. |
| `$TRUSTNOTE` | The bond — issued during contraction at a discount, redeemed during expansion at a premium. | Minted via `treasury.buyBonds(MONEY, targetPrice)` when MONEY trades sub-peg. |

## How the peg holds

The protocol defends `$MONEY ≈ 1 WETH` with three independent mechanisms:

1. **Hook tax (PegDefenseHook on Uniswap V4)** — every MONEY sell through the V4 pool passes through `beforeSwap`. Below par, a 14-tier tax (1–30%) is sliced off the input. Below the 1.10 ETH burn threshold, the slice is destroyed outright. Tomb-faithful tier table, ported to V4 hooks.
2. **Seigniorage (Treasury)** — every 6 hours, the Treasury ticks. Above 1.01 ETH, fresh MONEY is minted and routed to The Club (ESTATE stakers). The first 28 epochs (7 days) are unconditional expansion to seed the staking economy.
3. **Bond office (Treasury)** — below par, MONEY can be burned in exchange for TRUSTNOTE at a discount. Above the 1.10 premium threshold, TRUSTNOTE can be presented for more MONEY than was originally burned. Caps: 3% supply per epoch, 35% debt ratio.

Full mechanism documentation: [`/docs`](frontend/src/routes/Docs.tsx) (player-facing) and [`docs/AUDIT_HANDOFF.md`](docs/AUDIT_HANDOFF.md) (auditor).

## Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                          User Wallet                                │
└────────┬───────────────────────────────────────┬─────────┬─────────┘
         │                                       │         │
         │ approve + stake / deposit / burn      │ swap    │ wrap LP
         ▼                                       ▼         ▼
┌────────────────────┐    ┌────────────────────┐    ┌────────────────────┐
│   Boardroom        │    │   MiniSwapRouter   │    │ V4PositionWrapper  │
│   (The Club)       │    │   (in-house V4)    │    │   (LP NFT → ERC-20)│
└────────┬───────────┘    └────────┬───────────┘    └────────────────────┘
         │                         │                                       
         │ allocateSeigniorage     │ unlock + swap                          
         ▼                         ▼                                       
┌────────────────────┐    ┌────────────────────────────────┐   ┌──────────┐
│    Treasury         │    │       Uniswap V4 PoolManager  │   │  Oracle  │
│  (seigniorage,      │    │     ┌───────────────────┐     │   │  (TWAP)  │
│   bonds, epochs)    │◀──▶│     │  PegDefenseHook   │◀─── │  ─│          │
└────────┬───────────┘    │     │  14-tier tax +    │ tick│   │          │
         │                 │     │   beforeSwap obs   │ feed│   │          │
         │ mint            │     └───────────────────┘     │   └──────────┘
         ▼                 └────────────────────────────────┘                
┌────────────────────┐                                                     
│  $MONEY / $ESTATE / │                                                     
│  $TRUSTNOTE tokens  │                                                     
└────────────────────┘                                                     
```

## Stack

| Layer | Tools |
|---|---|
| Contracts | Foundry, Solidity 0.8.26, OpenZeppelin v5.4.0, Solady, Uniswap V4 core + periphery, Permit2 |
| Frontend | Vite + React 18 + TypeScript + Tailwind CSS + Wagmi 2 + Viem 2 + React Router 6 |
| Chain | Base mainnet (8453), Base Sepolia (84532) |
| Tooling | GitHub Actions (CI + keeper), Slither, forge invariant fuzz |

## Repository layout

```
oldMoney/
├── contracts/          Foundry workspace — src/, test/, script/, lib/
│   ├── src/
│   │   ├── core/           Treasury, Boardroom, Distributor
│   │   ├── distribution/   Genesis/Main/Share reward pools + V4PositionWrapper
│   │   ├── governance/     Trustees (Ownable2Step), Timelock
│   │   ├── hooks/          PegDefenseHook + BaseV4Hook
│   │   ├── oracle/         TWAP oracle reading from the hook
│   │   ├── swap/           MiniSwapRouter (in-house V4 router)
│   │   └── tokens/         OldMoney, Estate, TrustNote (ERC-20)
│   ├── script/         Deploy, KeeperTick, OpenGenesis, PostBootstrap, PushPrice,
│   │                   SeedLiquidity, governance rotation
│   └── test/           unit/, integration/ (Base mainnet fork), invariant/
│
├── frontend/           Vite app
│   ├── src/
│   │   ├── routes/         Landing, Dashboard, TheClub, TheVault, TrustNotes,
│   │   │                   Swap, Admin, Docs, PlaceholderPage
│   │   ├── components/     ActionPanel, BondForm, SwapCard, LaunchSequence,
│   │   │                   ToastProvider, etc. — Art Deco design grammar
│   │   ├── lib/
│   │   │   ├── abis/       Per-contract ABIs (typed via wagmi inference)
│   │   │   ├── hooks/      useTreasury, useBondMarket, useSwap, useMintPosition,
│   │   │   │               useUnwind, useTreasuryEvents, useIsAdmin, etc.
│   │   │   ├── swap/       TickMath + LiquidityAmounts + encoders (V4 client math)
│   │   │   └── addresses.ts  Deployment map keyed by chain id
│   │   └── styles/         Art Deco color palette + typography stack
│   └── public/         favicon.svg, og-image.svg
│
├── docs/
│   ├── AUDIT_HANDOFF.md       Single doc for an external auditor
│   ├── LAUNCH_RUNBOOK.md      Operator runbook (10 sections)
│   ├── DEPLOY.md              Per-chain deploy instructions
│   ├── DEPLOYED.md            Deployment address ledger
│   ├── GOVERNANCE.md          Timelock ceremony reference
│   ├── HOOK_TAX_DESIGN.md     Rationale for the 14-tier table
│   ├── SECURITY.md            Triage decisions
│   ├── TOMB_AUDIT.md          Bug-by-bug audit against Tomb's source
│   ├── GAP_AUDIT.md           Closed-gap reference
│   └── tomb-skill/            Canonical Tomb behavior reference
│
└── .github/workflows/
    ├── ci-contracts.yml       forge fmt + build + test on every PR
    └── keeper.yml             cron (every 30 min) calls allocateSeigniorage
```

## Quick start

### Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (forge, cast, anvil)
- Node.js 20+ and npm
- A wallet on Base Sepolia for testing (the deployer + small ETH for gas)
- An RPC endpoint for Base Sepolia (Alchemy / QuickNode / public)

### Contracts

```bash
cd contracts
forge install         # pulls submodules
forge build
forge test            # full suite, 356 tests, ~30s
forge test --profile deep --match-path "test/invariant/*"   # 250k calls/invariant, ~11min
slither src --filter-paths "lib|test" --exclude-low --exclude-informational
```

### Frontend

```bash
cd frontend
npm install
npm run dev           # Vite dev server at http://localhost:5173
npm run build         # production build to dist/
npm run typecheck     # tsc -p tsconfig.json --noEmit
```

### Deploy your own (testnet)

```bash
cd contracts
cp .env.example .env
# Edit .env with your DEPLOYER_PRIVATE_KEY, BASE_SEPOLIA_RPC_URL,
# AIRDROP_WALLET, COMMUNITY_FUND, DEV_FUND

forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --slow
forge script script/DeployTimelock.s.sol --rpc-url base_sepolia --broadcast
forge script script/SeedLiquidity.s.sol --rpc-url base_sepolia --broadcast --slow
```

After deploy, copy the printed addresses into `frontend/src/lib/addresses.ts` and follow [`docs/LAUNCH_RUNBOOK.md`](docs/LAUNCH_RUNBOOK.md) to open Genesis, configure fund cuts, and rotate governance.

## Token glossary

| Token | Contract | Tomb analog | Role |
|---|---|---|---|
| `$MONEY` | `OldMoney.sol` | TOMB | Algorithmic stable, pegged 1 WETH |
| `$ESTATE` | `Estate.sol` | TSHARE | Share / governance / seigniorage receiver |
| `$TRUSTNOTE` | `TrustNote.sol` | TBOND | Contraction bond |

## Contract glossary (themed → Tomb analog)

| Themed | Contract | Tomb analog |
|---|---|---|
| The Trust | `Treasury.sol` | Treasury |
| The Club | `Boardroom.sol` | Boardroom |
| The Vault | `GenesisRewardPool.sol`, `MainRewardPool.sol`, `ShareRewardPool.sol` | Pools (MasterChef) |
| The Hook | `PegDefenseHook.sol` | TaxOfficeV2 (replaced) |
| The Wrapper | `V4PositionWrapper.sol` | n/a (new for V4) |
| The Exchange | `MiniSwapRouter.sol` | (frontend wraps Uniswap) |
| Oracle | `Oracle.sol` | Oracle |

NatSpec headers on every contract document the original Tomb mechanism for auditors.

## Documentation

| For | Document |
|---|---|
| Anyone running the protocol | [`docs/LAUNCH_RUNBOOK.md`](docs/LAUNCH_RUNBOOK.md) — operator runbook, 10 sections |
| An external auditor | [`docs/AUDIT_HANDOFF.md`](docs/AUDIT_HANDOFF.md) — scope, threat model, test surface |
| Players exploring the protocol | `/docs` in the running frontend ([`Docs.tsx`](frontend/src/routes/Docs.tsx)) |
| Tomb-fidelity verification | [`docs/TOMB_AUDIT.md`](docs/TOMB_AUDIT.md) + [`docs/tomb-skill/`](docs/tomb-skill/) |
| V4 hook design rationale | [`docs/HOOK_TAX_DESIGN.md`](docs/HOOK_TAX_DESIGN.md) |
| Governance ceremony | [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md) |

## Test coverage

| Suite | Coverage | Count |
|---|---|---|
| Unit | Per-contract behavioral tests | ~290 |
| Integration | Multi-contract flows + Base mainnet fork tests | 36 (6 are fork-gated) |
| Invariant (default) | 4 invariants × 7 suites, 256 runs × 50 depth | 42 |
| Invariant (deep) | Same suites, 2,500 × 100 — verified ~11 min | 42 |
| Invariant (audit) | Same suites, 10,000 × 200 — verified ~113 min | 42 |

Run any profile via `forge test --profile <default|deep|audit>`. The audit profile is what we'll point an external auditor at.

## Acknowledgements

The economic mechanism is a faithful port of [Tomb Finance](https://github.com/Tomb-Finance) (`bombmoney/bomb-contracts`). Every deviation from Tomb is documented in [`docs/TOMB_AUDIT.md`](docs/TOMB_AUDIT.md). Tomb's contributors did the load-bearing economic-design work; this repo adapts their model to V4 and modern Solidity tooling.

## License

BUSL-1.1 (Business Source License). See individual SPDX headers in `contracts/src/`. Conversion date to MIT pending governance decision.

## Status disclaimer

This is an algorithmic-stable protocol — a speculative instrument. The peg holds while the mechanism's incentives outweigh participants' willingness to exit. When confidence breaks, peg can break with it. Use at your own risk and read the [Risks](frontend/src/routes/Docs.tsx) section of the in-app docs before participating.
