# xTOMB v5 integration handoff

Use your editable xTomb v5 project as the design baseline. Push the branch cut from 7e3115f and share its URL. The v5 ZIP is the visual reference. The React frontend on merge is the source for the working Wizard and operator logic.

The ABI JSON arrays in abi/ were emitted by Foundry from 0xbasedev/v4-tomb merge at 02858c6. manifest.json maps each ABI to its source. These ABIs describe interfaces. Resolve deployment addresses from the reviewed, verified release configuration.

## Setup Wizard

Port the existing Wizard behavior into v5. Keep chain selection, published infrastructure defaults, editable fields, Release ID generation, CREATE3 prefix and suffix search, draft import/export, and deferred Genesis scheduling. Reuse the shared planner in config/create3-plan.mjs and the UI logic in frontend/src/xtomb/setup. Preserve mined nonces and hook permission bits. The Wizard prepares a plan without sending transactions.

## Admin

Use MasonryGenesisSchedule for scheduler(), start(), lpOpens(), end() and the one-time schedule(uint256) write. Check the selected chain, expected governance signer, staking funding and settlement binding before the wallet prompt. Simulate writes and show confirmed on-chain state after the receipt. Bring over the existing address-plan review and CreateX/code checks. Separate editable launch settings, immutable deployed settings, and role-gated controls. Only render live controls backed by an actual method and a verified deployment. Treasury and Boardroom in this bundle are inherited WETH-era interfaces. The Masonry-specific Treasury/Farm deployment and live wiring remain separate work.

## Bridge

Keep Base, BNB Smart Chain, PulseChain and Sonic visible and greyed out until verified. Robinhood Chain is not a bridge network. Use XTombShareBridge for route reads, quoteSend and send. Canonical xSHARE sends may need ERC-20 approval. Wrapped xSHARE sends burn through the bridge. A source receipt starts delivery tracking. Read delivered(messageId) from IHyperlaneMailbox on the destination before showing delivery complete. Keep route and peer configuration behind owner checks. See reference/XSHARE_BRIDGE.md for activation and verification details.

Keep Claude's v5 layout, typography, existing routes and token names. Integrate the three screens on the editable branch and test disconnected wallets, wrong chains, missing deployments, rejected signatures and confirmed transactions.

## Integrated frontend

The merge branch now incorporates xtomb-masonry through 6f0be3e. Your main.tsx, route components, theme, preview behavior and pnpm lockfile are the active frontend.

The backend retains deferred Genesis scheduling, generic PegToken/ShareToken source names, and per-role CREATE3 address patterns. The earlier working operator implementation is retained in frontend/src/xtomb/setup as a reference for porting into your own Wizard and Admin. The active v5 Wizard/Admin routes still need those newer capabilities integrated.

Priorities for the next session

1. Preserve your v5 design and the existing Bridge page.
2. Port addressPatterns and addressNonces support into frontend/src/lib/create3 and components/wizard/ReleaseStep, using config/create3-plan.mjs. Include both prefix and suffix controls and hook permission validation.
3. Port deferred Genesis scheduling from frontend/src/xtomb/setup/GenesisScheduling.tsx into routes/Admin.tsx. Use the new schedule constructor and the actual scheduler authorization.
4. Reconcile the active Wizard's date-required behavior with the new zero-as-unscheduled Genesis contract.
5. Import the compiler-generated ABI bundle and validate each method against the deployment you are enabling.
6. Keep pending live deployment integrations clearly marked. Complete the modern token/Treasury/Farm deployment path before enabling user transactions.

The ABI archive xTOMB-ABI-02858c6.zip is compiled from the current backend source revision. The frontend merge does not alter those contract implementations.

Compiler ABI files are committed under frontend/abi-handoff, grouped for your generator. From frontend, run node scripts/gen-abis.mjs abi-handoff, then resolve any caller mismatch against the emitted signatures and rerun the build. The previous handoff's three raw bridge ABI files were also replaced with compiled output.

Validation during integration

The TypeScript and production build passed. The browser suite could not start its pnpm-managed test server in this environment, so no passing browser-suite result is claimed for the combined frontend. Run pnpm install --frozen-lockfile and pnpm test:browser in your checkout before merging further or enabling transactions. Vite reports a large production chunk.

## Status from Claude (branch claude/v5-operator)

Done on top of 8c3dba4:

- ABIs regenerated from `frontend/abi-handoff` (57 modules). Every method the app calls was checked against the emitted signatures. Swaps now bind `IMasonryExactInputV4Router` (MiniSwapRouter is the implementation), and ERC-20 reads use `IERC20`.
- CREATE3: `frontend/src/lib/create3.ts` now calls `config/create3-plan.mjs` (no forked copy). Mining runs in a Web Worker. Wizard step 4 has per-role prefix/suffix controls validated by `validateAddressPatterns`, shows mined `hookNonces` and `addressNonces`, and imports/exports `release.json` (with `addressPatterns`). Model tests check the browser plan against `scripts/create3.mjs`, patterns included. `masonrySwapRouter` is planned.
- Deferred Genesis: Wizard start is optional (blank = 0 = unscheduled) and asks for the scheduler. Admin has a one-time `schedule(uint256)` panel for `scheduler()`. Before the wallet prompt it checks the chain, the scheduler, `start() == 0`, staking's schedule/settlement wiring, `funded()`, the settlement binding and a future time. It simulates, re-checks the account and chain at signing, waits for the receipt and re-reads.
- Unscheduled state is first-class. Note that `MasonryGenesisPass.purchase` reverts while `end() == 0`, so pass sales and staking are closed with reasons until scheduling.
- Shared write path: aborts if the wallet or chain changes between simulation and signing. Rejected signatures say nothing was sent.
- Browser suite: model, desktop and mobile projects pass locally, covering disconnected wallets, wrong and bridge-only chains, missing deployments, unscheduled Genesis, Admin scheduling (simulated), address patterns, and zero transaction requests in Preview.
- Not yet tested: rejected signatures and confirmed transactions. Both need a verified deployment entry (or a local anvil deployment wired into a test profile) before the live write path can run end to end.

Still pending: live user transactions (the modern token/Treasury/Farm deployment path), bridge activation, and a verified `config/masonry-deployments.json` entry.

## Deferred polish (next preview pass)

- **Move the preview "Sim" pill off the content area on phones** (deferred 2026-11-11, polish, not a fix). `PreviewDock` is `fixed bottom-24 left-4` and takes taps, so on a phone it can sit over the left edge of an action button scrolled just into view (measured: 43px of the Swap "Remove liquidity" button at 412px). Dock it beside the Sample wallet chip in the header, where the sim state already shows. It is a control, so `pointer-events: none` is not an option. Preview-only: it renders nothing when preview is off.
