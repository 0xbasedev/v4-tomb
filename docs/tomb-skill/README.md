# Tomb Finance skill

Reference documentation for Tomb Finance's protocol mechanics. The user (brandon) authored this skill on 2026-05-22 in response to a pattern of one-by-one Tomb-mechanism gaps surfacing during the Old Money port (V4 LP token, genesis-as-mini-ICO, Boardroom-empty brick). This is the canonical reference Old Money is faithful to — when in doubt, read this BEFORE writing code.

## Contents

- `SKILL.md` — main reference (architecture, all key contracts, supply tier table, allocateSeigniorage flow, buyBonds/redeemBonds math, Masonry mechanics, phase semantics, gotchas)
- `references/Treasury.sol.md` — annotated source walkthrough of Tomb's Treasury
- `references/Masonry.sol.md` — annotated source walkthrough of Tomb's Masonry
- `references/TShare.sol.md` — annotated source walkthrough of Tomb's TShare token

## How Old Money uses this skill

Every contract we ship on Old Money has a Tomb counterpart documented here. The mapping:

| Tomb | Old Money | Status |
|---|---|---|
| TOMB | $MONEY (`OldMoney`) | Tomb-faithful + adds ERC20Permit |
| TSHARE | $ESTATE (`Estate`) | Tomb-faithful |
| TBOND | $TRUSTNOTE (`TrustNote`) | Tomb-faithful |
| Treasury | `Treasury` (renamed `Trustees` base) | Tomb-faithful + ReentrancyGuard |
| Masonry | `Boardroom` | Tomb-faithful |
| Oracle | `Oracle` | Tomb-faithful interface; tick-cumulative source instead of V2 cumulative |
| TombGenesisRewardPool | `GenesisRewardPool` | Tomb-faithful |
| TombRewardPool | `MainRewardPool` | Tomb-faithful |
| TShareRewardPool | `ShareRewardPool` | Tomb-faithful |
| Timelock | `Timelock` | Tomb-faithful |
| TaxOffice / TaxOfficeV2 | `PegDefenseHook` (V4 hook) | **Deliberate deviation** — see gap #3 |
| Distributor | `Distributor` | Tomb-faithful |
| (FTM peg) | (cbETH peg) | Different paired asset, same algebra |

## Required reading order before any new sprint

1. Skim `SKILL.md` start to end (~10 min).
2. Open `references/Treasury.sol.md` and walk through `allocateSeigniorage`, `buyBonds`, `redeemBonds` once.
3. Cross-check our implementation in `contracts/src/core/Treasury.sol` against the documented behavior.
4. Re-run the user-flow walkthrough (see `memory/feedback_user_flow_walkthrough.md` for the process).

## Current state of the Old Money audit against this skill

See `docs/TOMB_AUDIT.md` (next document to produce) — systematic walkthrough of every claim in `SKILL.md` checked against our `src/` and `script/` code, with deltas explicitly documented.
