# Handoff — Masonry local launch (for Cursor / Copilot)

Branch `claude/local-launch` · base `merge` @ a8d1ea5 · written 2026-11-05 by Claude.

## User decisions (latest — take precedence over older docs)

- **xBOND:** later, after launch. Keep the Bonds page as a labelled planned preview. No bond behavior in Treasury for this launch.
- **Chains:** Base first. BSC joins later as an xSHARE bridge satellite (Bridged xSHARE), one xSHARE and one 33,333 cap. No simultaneous BSC Genesis, which also avoids BSC's 18-decimal Binance-Peg USDC (the Masonry contracts require 6).
- **xSHARE supply:** parameterize `ShareToken` (done here). xTOMB uses `PegToken` as-is.
- Public names xTOMB / xSHARE; source names PegToken / ShareToken. Everything else is as in `docs/CLAUDE_NEXT_STEPS.md` (7-day Genesis, LP at +24h, 50/100/500 USDC passes with equal weighting, Genesis xTOMB sell tax 3%–12% burned, buys and transfers untaxed, Genesis may deploy unscheduled, CreateX/CREATE3 for every project address).

## Done in this branch

`contracts/src/tokens/ShareToken.sol` now takes `ShareToken.Config` in its constructor:

- `name`, `symbol`, `maxSupply` (hard cap on cumulative minting, enforced in `_update`)
- `initial[]` allocations minted at deploy
- `farmingAllocation` minted once via `distributeReward`
- optional legacy linear drip (`communityFundAllocation`, `devFundAllocation`, `vestingStart`, `vestingDuration`)
- new `totalMinted` and `totalBurned` counters

Old getters (`FARMING_POOL_REWARD_ALLOCATION`, `VESTING_DURATION`, …) remain as immutables. `ShareTokenProfiles.legacy(...)` reproduces the Tomb-exact ESTATE schedule (cap 70,001). `script/Deploy.s.sol` and all 14 legacy call sites use it.

**Tests actually run:** `forge test --no-match-path 'test/integration/BaseFork*'` gave 425 passed, 1 skipped, 0 failed. One test needs `mkdir -p contracts/deployment-output` in a fresh checkout. **Not run:** Base fork suites (need `BASE_RPC_URL`).

## Done in round 2 — working local launch + live wallet flows

- **`ShareTokenProfiles.masonry(initial[], farming, cap)`** requires `sum(initial) + farming == cap`, else `InvalidConfiguration`. It is named `xSHARE` and has no drip. Tests are in `test/unit/ShareTokenMasonry.t.sol` (7): metadata, farming minted once up to the cap, no drip, burns counted, profile mismatch, over-cap constructor, zero recipient.
- **`contracts/script/DeployMasonryLocal.s.sol`** builds the full Masonry stack on anvil and writes `contracts/deployment-output/masonry-local.json` (gitignored). Verified on-chain with `cast`:
  - Genesis deployed unscheduled (`start == 0`, scheduler = deployer); staking funded; settlement bound; LP burn fee pointed at staking.
  - xSHARE supply 7,692 / 33,333 (farming 25,641 still unminted).
  - Pass purchase reverts while unscheduled.
  - `schedule()` works once; a second call reverts.
- **Frontend local mode:** `VITE_LOCAL_DEPLOYMENT=1` loads that JSON and adds chain 31337 "Local (anvil)" (testnet) to REGISTRY and wagmi. Without the flag nothing changes: Preview stays the default.
- **`frontend/test/local.spec.ts` + `playwright.local.config.ts`** (`pnpm test:local`). The injected wallet forwards every RPC call to anvil account 0 and can refuse signing with EIP-1193 code 4001. All 4 tests pass:
  1. Unscheduled deployment: Mint is disabled; Admin readiness shows 6/6 ✓.
  2. Rejected signature: shows "You declined…", the wallet records no send, the nonce is unchanged, and Genesis stays unscheduled.
  3. Admin schedules Genesis: simulate → sign → receipt → "Scheduled for" read back from chain.
  4. Buy Genesis, upgrade to Pro for the $50 difference (transfer logs sum to exactly 100 USDC), then time travel (chain + browser clock); stake 100 USDC shows a stake of 100; withdraw 40 shows a stake of 60.

### Bugs the live run found (fixed here)

1. **False "Confirmed".** `useActions.run(label, [])`, used when an action can't be built, toasted "· Confirmed" with nothing sent. It now shows "· Not sent".
2. **Stake never sent.** `PoolPanel` always passed `standardAsset = null`, so pool-0 deposits hit bug 1. Deposit and withdraw now read `staking.standardAsset()` and the asset's `decimals()` on-chain.
3. **Pool-0 amounts used 18 decimals.** Positions and totals are in standard-asset units (USDC, 6), so 100 USDC showed as 0. Withdraw sent `e18(shares)`, which reverts. Display and write paths now use the on-chain decimals; display is `null` until they're known.
4. **Calls without a pinned chain.** Wallet-flow calls (`readContract`, `simulateContract`, `writeContract`, `waitForTransactionReceipt`) didn't pin `chainId`, so they could resolve to another configured chain's transport. They're now pinned to the deployment chain.
5. **LP-burn pending USDC used 18 decimals.** `lpBurn.pendingUsdc` was formatted with 18 decimals; it now uses 6.

### Tests actually run (2026-11-05, this branch)

- `forge test --offline --no-match-contract BaseFork`: 439 passed, 1 skipped, 0 failed (includes 8 new pass-upgrade tests).
- `pnpm typecheck`, `pnpm build`: OK.
- `pnpm test:browser`: 67/67 on the last run, which includes the new pass-upgrade test. Earlier on this branch one test,  `[mobile] Swap … LP → USDC … untaxed exit`, was intermittent (2 of 3 on rerun): Playwright reports "element is not stable" on the animated "Take it as xTOMB instead" nudge. That is Preview-only code this branch doesn't touch. Fix by pausing the nudge animation while it's hovered/focused (or under reduced motion), not with `force: true`.
- `pnpm test:local`: 4/4 on a fresh anvil.

### How to run the live suite

```
anvil --port 8545 --code-size-limit 100000 &
cd contracts && forge script script/DeployMasonryLocal.s.sol:DeployMasonryLocal --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --broadcast --disable-code-size-limit --non-interactive --offline
cd ../frontend && pnpm test:local
```

- `--disable-code-size-limit` is only needed for the local v4 `PoolManager`. Every Masonry contract is under 24 KB; the largest, `MasonrySquareHook`, is 22,078 bytes.
- `--offline` stops forge from hanging on sourcify lookups behind restrictive egress.
- The suite needs a **fresh** anvil each run: it schedules once and time-travels, and a `beforeAll` guard fails fast if chain time drifts from wall time.

### Pass upgrades (round 3)

`MasonryGenesisPass.upgrade(tier)` raises the held pass in place for the price difference (same soulbound token, `tokenOf` added, `Upgraded` event); closes at Genesis end. UI: PassPicker shows "Upgrade for N USDC" on higher tiers and stays open until Ultra. Copy now says passes can't be transferred. ABI regenerated.

## Not done — next steps, in order

1. **CREATE3 locally.** `DeployMasonryLocal` uses plain CREATE (plus the mined CREATE2 salt for hooks). Next: `vm.etch` the CreateX runtime at `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` (check `factoryCodeHash` in `config/create3-plan.mjs`) and deploy through it so addresses match the Wizard's plan. Hooks still need flag-mined addresses, so verify CREATE3 + flags with `HookMiner` against CreateX's guarded-salt derivation.
2. **Real launch amounts.** The local deploy uses placeholders: xSHARE initial (deployer 7,042 standing in for the vesting buckets; 100 sale; 500 treasury; 50 arbitrage), a Genesis reward budget of 1,050,000 xTOMB, and seed liquidity. Owner decisions still open: the template's `authorizedLaunchSupply`, the Genesis reward budget, and the vesting bucket amounts and contracts (`MasonryLinearVesting`).
3. **PegToken `totalBurned`.** Add a counter like ShareToken's, or track burns from events (status-doc item 6).
4. **Wrong chain mid-flow (live).** `useActions.still()` guards it, but no live test covers it yet. In the injected wallet, emit `chainChanged` after simulation and before signing, then assert "The wallet account or network changed. Nothing was sent…".
5. **More live flows.** Not yet covered: claim, compound to LP, keeper opt-in, the LP pool after +24h, and a swap with the Genesis sell tax. Same pattern: advance chain and browser clocks together.
6. **ABIs.** No change needed. The only ShareToken ABI in the frontend is the Old Money reference (`legacyShareToken.ts`, study only); the app reads xSHARE through `iERC20`. If the ABI owner exports the source `ShareToken`, regenerate with `node scripts/gen-abis.mjs abi-handoff`.
7. **Bridge activation** stays off until reciprocal peers, ISMs, route limits and relayer support are verified. Keep unavailable routes greyed out.

## Known facts that bite

- `MasonryGenesisPass.purchase` reverts while Genesis is unscheduled (`end() == 0`). Pass sales and staking open only after `schedule()`. The UI already says so.
- Staking `fund()` must happen before Genesis starts, and `schedule()` requires staking funded and settlement bound (Admin checks this).
- PulseChain needs the bridge compiled for Shanghai (`foundry.toml` restriction already set).
- Frontend: `pnpm install --frozen-lockfile && pnpm test:browser` (65 tests, all Preview mode); `pnpm test:local` for live anvil flows.
- The Genesis countdown and phase gates run on the **browser clock**; contracts use `block.timestamp`. On real chains they agree. In tests, move both together (`evm_increaseTime` + `page.clock`).
