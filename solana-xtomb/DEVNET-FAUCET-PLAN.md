# Devnet SOL top-up plan — xTOMB deploy rehearsal

Prepared: 2026-11-05 evening (for the morning of 2026-11-06). Jess said he will add more devnet SOL in the morning; this is the ready-to-use plan, not a faucet run — no faucet was used tonight.

## The numbers (from ~/workspace/solana-xtomb/MORNING-REPORT.md)

- Devnet wallet: `G2ZnxDj62Au7dRtEd4Pu5Qt8QxjH9PbA8DNSwRcYoPBs`
- Balance: 1.65693948 SOL
- Program account rent alone: 3.51934272 SOL → shortfall **1.86240324 SOL**
- Peak at deploy (program + buffer, buffer rent refunded after success): 7.03868544 SOL + fees → shortfall vs peak **5.38174596 SOL**
- Target: send **~5.4 SOL** to cover the peak comfortably; **~1.9 SOL** is the bare net minimum.

## Faucet options, ranked (checked via web search 2026-11-05 evening; limits change — re-check on the page before claiming)

1. **JTools devnet faucet** — best single-shot option. Docs say: up to 25 SOL per 24h and 75 SOL per 7 days (rolling windows), amounts 0.1–25 SOL per claim, no login, no wallet connection, no signature. One claim of ~5.5 SOL would cover the whole peak shortfall. Caveat: claims can be paused ("Back soon"); wallet must hold under 25 SOL (it holds 1.66, fine). Docs: https://docs.j.tools/tools/utilities/devnet-faucet
2. **Official Solana faucet — faucet.solana.com** — 2 SOL per request, 2 requests per 8 hours anonymous; signing in with GitHub raises the allowance. Two or three claims across the morning would cover the net shortfall, but not the peak in one go.
3. **Solana CLI airdrop** — `solana airdrop 2 --url devnet` (2 SOL per request). Same public-RPC limits as the official faucet; repeat after the cooldown if needed.
4. **QuickNode faucet — faucet.quicknode.com/solana/devnet** — one drip per network every 12 hours; requires a small mainnet balance on the claiming wallet.
5. **SolFaucet (solfaucet.com) / DevnetFaucet.org** — community backups, ~1 SOL per claim, separate rate limits from the public RPC; useful when the official tap is drained.
6. **Ellipsis Labs proof-of-work faucet** — effectively uncapped but slow (mines in background); fallback only, not the morning path.

## AI-agent note

The official faucet's 2026 guidance explicitly tells AI agents not to use the web interface, directing agentic tools to the CLI airdrop, the PoW faucet, or a local validator instead. So Bingo should not run the web faucet itself — Jess (or the CLI on his machine) does the claiming; Bingo only prepared the plan.

## After the top-up

Say go and the deploy rehearsal is: `initialize_config` → `create_mints` → fund Genesis budget → set wallets/oracle → frontend points at the real program. Devnet only, no mainnet, no push. Re-check the balance first (`solana balance G2ZnxDj62Au7dRtEd4Pu5Qt8QxjH9PbA8DNSwRcYoPBs`) — Jess may already have topped it up.
