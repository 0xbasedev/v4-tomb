# xTOMB Solana frontend — BUILD NOTES

Date: 2026-11-05 (overnight build, Jess asleep). Builder: frontend subagent.
Tree: `~/workspace/solana-xtomb/frontend/` — Next.js 15.5.29 (App Router) + Tailwind v4,
Solana wallet adapter (Phantom + Solflare), GSAP route tweens, Lottie in the swap-confirm
modal only. Devnet default. Program ID from `NEXT_PUBLIC_XTOMB_PROGRAM_ID`
(default `4En9hXzHXTSNvwizNya8oit7MTLfsJxsShnMLgkjttEY` — fresh devnet-only program,
NOT deployed yet).

## What was built

- Routes (all static, all in the Obsidian Crypt theme): `/` Dashboard, `/genesis`,
  `/farm`, `/masonry`, `/swap`, `/bonds`, `/docs`, `/admin`, `/wizard`, `/bridge`.
- Theme extracted from `ui-source/` (compiled Vite build — never patched): bg `#050507`,
  panels `#0b0c10`/`#111319`, text `#ffffff`/`#9ca3af`/`#7c7a74`, paper `#ece8df`,
  orange `#ff6a2b`, accents `#ff4d6a`/`#3ee7ff`/`#ffc24b`/`#ffb547`/`#b48cff`/`#34e3a0`.
  Fonts copied from the artifact (latin woff2 only) into `public/fonts/` and
  `@font-face`d: Unbounded (display), Inter (body), JetBrains Mono (numbers/labels).
  Bottom nav Dashboard / Genesis / Swap / Bridge / More; top bar with xTOMB wordmark +
  wallet pill; clipped-corner orange gradient CTAs; `SIMULATED`/`PLANNED` badges.
- All economics come from `src/lib/xtomb.config.json` (copy of
  `~/workspace/solana-xtomb/config/xtomb.config.json`, imported via `src/lib/config.ts`
  — no hard-coded economics in components). Fire Tax curve is computed in code from
  config (1% baseline at/above peg, quadratic to 12% at/below 85% of peg).
- UX laws verified: ONE TokenPicker (`src/components/ui.tsx`, all 10 tokens) used
  everywhere; `grep -rn '<select' src/` → zero matches; `grep -rni 'unavailable' src/`
  → zero matches. Zap panels on Genesis / Farm / Swap. Heavy modals for pass
  purchase/upgrade, stake/claim/compound, farm actions, swap confirm, bond buy/redeem,
  admin actions. Swap has route chips (Buy/Sell/Enter LP/Exit LP/Add LP/Remove LP) and
  Fire Tax + pool fee itemized separately before signing.
- Genesis: pass cards ($50/$100/$500), upgrade modal (pay-only-difference),
  stake/claim/compound modals, live 3h cooldown countdowns, 16-installment vesting
  tracker, Ultra-NFT stake card (5% of emissions).
- Docs: sections I–XII + interactive Fire Tax explorer (TWAP slider → tax %),
  TWAP/epoch wheel, claim-settle visual (installments claim in order).
- Bonds: TWAP slider gates buy (&lt;$1.00) / redeem (&gt;$1.00) with honest disabled states.
- Bridge: PLANNED page with the artifact's honest copy (soulbound passes, xSHARE has
  no bridge, needs new audited contracts).
- Launch Wizard: 7 steps, config-first whole numbers/percentages, hostile validation
  with plain error messages (wrong cap/emissions/prices/duration rejected), deploy
  gates (no audit / no live-chain verification) the operator must acknowledge.
  Copy states "The wizard deploys; Admin maintains." Deploy button is a preview only
  until a program exists — see Open items.
- Admin: owner-gated UI (wallet connect), add pools, fee config, four wallets, oracle
  rotate, expansion cap, epoch/TWAP/reserve, roles, bond actions, maintenance toggle.
- Honesty: every transacting button is either disabled with "Simulated — no program
  deployed yet" or opens a modal saying so plainly. No live balances, prices, or
  transactions anywhere.

## Exact verification output

### npm install (network OK, slow)
```
added 1107 packages in 8m
```
Warnings only: deprecated lodash.isequal, uuid, @ledgerhq/*, @toruslabs/solana-embed,
@walletconnect/*, crypto-js, @stellar/stellar-base; one ERESOLVE peer-dependency
override warning. No failures.

### Build — first attempt FAILED (my bug, fixed)
```
Failed to compile.
./src/lib/confirmAnimation.json
Module parse failed: Cannot parse JSON: Expected ',' or ']' after array element
in JSON at position 359
```
Cause: hand-written Lottie JSON used an invalid ellipse shape (`"ks"` instead of
`"s"`/`"p"`). Rewrote it with a Python generator (`fix_anim.py`, deleted after use)
and validated with `json.load` — parses OK, 3 layers (dot, ring, check).

### Build — second attempt FAILED (React resolution, fixed)
```
✓ Compiled successfully in 70s
[Error: Failed to collect configuration for /_not-found] {
  [cause]: TypeError: (0 , d.createContext) is not a function
```
Cause: `layout.tsx` (a server component) imported `WalletMultiButton` from
`@solana/wallet-adapter-react-ui` directly. Fix: moved the wallet button into a
client component `src/components/TopBar.tsx` (`"use client"`); layout imports that.
Also fixed a viewport warning by moving `viewport` out of `metadata` into a
`viewport` export.

### Build — FINAL, clean (twice, after the viewport fix)
```
✓ Compiled successfully in 70s
✓ Generating static pages (13/13)
Route (app)                                 Size  First Load JS
┌ ○ /                                    4.22 kB         110 kB
├ ○ /_not-found                            993 B         104 kB
├ ○ /admin                               6.15 kB         109 kB
├ ○ /bonds                               4.89 kB         107 kB
├ ○ /bridge                               4.2 kB         107 kB
├ ○ /docs                                6.14 kB         109 kB
├ ○ /farm                                4.79 kB         107 kB
├ ○ /genesis                              6.1 kB         109 kB
├ ○ /masonry                             5.03 kB         108 kB
├ ○ /swap                                6.47 kB         109 kB
└ ○ /wizard                              6.91 kB         109 kB
+ First Load JS shared by all             103 kB
○  (Static)  prerendered as static content
```
No warnings in the final build.

### Serving — production server, all routes 200
`PORT=3107 npm run start` → `✓ Ready in 1548ms`
```
/ 200 19566B      /genesis 200 25857B   /farm 200 19193B
/masonry 200 17702B  /swap 200 18342B   /bonds 200 15509B
/docs 200 24716B  /admin 200 21135B    /wizard 200 16390B
/bridge 200 15429B
```
Homepage HTML contains `SIMULATED`, `Select Wallet`, 12× `xTOMB`.
Fonts: `unbounded-latin.woff2 200`, `inter-latin.woff2 200`,
`jetbrains-mono-latin.woff2 200`.
Server left running on port 3107 (started with nohup after a runtime service
restart killed the first instance — see below). Restart with:
`cd ~/workspace/solana-xtomb/frontend && PORT=3107 npm run start`.

### Mobile overflow — PASS, real headless Chromium
Used the cached `chrome-headless-shell` (`~/.cache/ms-playwright/
chromium_headless_shell-1248/...`) driven over CDP from a plain Node script
(`check-overflow.cjs`), 390×844 mobile viewport, `documentElement.scrollWidth`
vs `innerWidth` on every route:
```
/ scrollWidth=390 innerWidth=390 overflowers=[]
/genesis scrollWidth=390 innerWidth=390 overflowers=[]
/farm scrollWidth=390 innerWidth=390 overflowers=[]
/masonry scrollWidth=390 innerWidth=390 overflowers=[]
/swap scrollWidth=390 innerWidth=390 overflowers=[]
/bonds scrollWidth=390 innerWidth=390 overflowers=[]
/docs scrollWidth=390 innerWidth=390 overflowers=[]
/admin scrollWidth=390 innerWidth=390 overflowers=[]
/wizard scrollWidth=390 innerWidth=390 overflowers=[]
/bridge scrollWidth=390 innerWidth=390 overflowers=[]
OVERFLOW CHECK: PASS — 0px horizontal overflow at 390px on all routes
```

### Swap-confirm modal + Lottie — PASS, live in headless Chromium
`check-modal.cjs` (CDP): clicked "Review swap" on `/swap` at 390px:
```
click: clicked
modal check: {"modal":true,"lottieSvg":1,"bodyHasCheck":true}
console errors/exceptions: none
```
The Confirm swap modal opens, the Lottie animation mounts (1 SVG in the DOM),
no console errors or exceptions on that flow.

## Decisions where the spec was ambiguous
- `src/lib/xtomb.config.json` is a *copy* of the shared config (Next cannot import
  JSON from outside the app root cleanly). Keep in sync by hand until a build-time
  copy step exists; the file header says so.
- Simulated TWAP values used for previews: Swap $0.97, Bonds slider default $0.90,
  Docs explorer default $0.92. All labeled simulated.
- Pool fee on Swap is a simulated 0.30% shown itemized separately from Fire Tax
  (spec requires itemization; no live pool fee exists yet).
- Genesis cooldown countdowns start at 3:00:00 as a live ticking preview, not a
  real per-user cooldown (no program/wallet state exists yet).
- Wizard "Deploy to devnet" button shows a preview-only notice; it does not call
  any deploy script (no program binary exists in this tree).
- Admin owner-gating is UI-level only (wallet connected or not); there is no
  on-chain owner to check against until deploy.

## Incidents during the build
- The runtime service restarted once mid-verification (during a duplicate-dispatched
  exec call); it killed the first production server instance. Server was restarted
  with nohup on port 3107 and re-verified 200. No files were lost.

## Open items / not verified
- No program is deployed, so no real wallet transaction, balance, or on-chain read
  has been tested — everything is honestly labeled Simulated.
- Lottie animation JSON is hand-authored and validated as JSON + confirmed mounted
  as an SVG in headless Chrome; its visual dot→ring→check timing was not watched
  by a human eye (no live browser in this lane).
- GSAP route tween was verified only as code + no console errors; the visual tween
  was not eyeballed.
- `node_modules/` is 1.5 GB (wallet-adapter dependency tree). Not committed anywhere;
  no GitHub push was made, no repo touched.
- The wizard's real devnet deploy path (Anchor program build → deploy script) is
  the program lane's work, not this frontend's.
