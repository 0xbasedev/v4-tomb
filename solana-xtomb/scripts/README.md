# xTOMB keeper scripts

Two off-chain cranks for the Solana xTOMB program. Both are **devnet-only**
until a program is deployed and an audit exists. Neither custodies user
funds. Both support `--dry-run` (print what would happen, send nothing).

## keeper.ts — auto-compound crank

Compounds due Pro (6h cadence) and Ultra (3h cadence) positions. The
on-chain 3h hard cap is enforced by the program; the crank checks it
first to avoid wasted transactions. The 2% keeper fee goes to Treasury,
not to the keeper.

```bash
# needs scripts/owners.json: {"owners": ["<owner pubkey>", ...]}
npx ts-node scripts/keeper.ts --dry-run --once
npx ts-node scripts/keeper.ts --once --pools 1,2,3,4
npx ts-node scripts/keeper.ts --interval-secs 600
```

Env: `RPC_URL` (default devnet), `KEYPAIR_PATH` (default
`~/.config/solana/id.json`), `PROGRAM_ID` (default from
`config/xtomb.config.json`).

## peg-bot.ts — oracle poster + buyback-and-burn

Posts the TWAP via `set_oracle` and, while TWAP is at or below $1.01,
burns the bot's own xTOMB via the guarded `buyback_and_burn`
instruction (caller must be the bot wallet or admin). With
`--advance-epochs` it also settles due epochs via `advance_epoch(false)`
— Epoch 0 is never triggered by this bot (manual Admin action only).

The TWAP comes from `--twap <e6>` or `--twap-file <path>` (JSON
`{"twap_e6": 987000}`). **A live price-feed integration (Jupiter /
Raydium pool parse) is still a TODO** — until it exists, the operator
supplies the TWAP. This bot key is the oracle authority in config.

```bash
npx ts-node scripts/peg-bot.ts --dry-run --once --twap 990000
npx ts-node scripts/peg-bot.ts --once --twap-file ./twap.json --max-burn 5000000 --advance-epochs
npx ts-node scripts/peg-bot.ts --interval-secs 300 --twap-file ./twap.json
```

## Status

Written 2026-11-05, typechecked (`npx tsc --noEmit scripts/keeper.ts
scripts/peg-bot.ts`). **Not run against a live program** — no program is
deployed yet (devnet wallet is ~1.86 SOL short of the program-account
rent alone). Verify with `--dry-run` first once a program exists, then
one `--once` run before leaving either script looping.
