# Robinhood-first frontend (local only)

## Runtime

`config/frontend-networks.json` controls the chain picker, primary chain, availability flags and placeholder icon monograms. Robinhood is the only enabled destination, not a claim that the protocol is launched. Expansion networks are selectable to view Coming soon; selection does not request transactions. The return button switches the connected wallet, adds Robinhood only after error 4902, then switches again. Rejection is surfaced without trying another route.

`config/masonry-deployments.json` is empty. No protocol token, pass, Treasury, router, hook, pool or staking address is invented. Records must pass `parseMasonryDeployment` before reads/writes can use them. Inactive chains never receive a live deployment. Disconnected public reads use the selected chain, never the first record on another chain.

The default transactional pages show Not launched yet. The old UI is preserved behind explicit `?preview=1`; its sample data and actions remain clearly simulated. No implicit preview is enabled by missing addresses. Header chain controls work disconnected and on mobile. Existing simulation tests now opt in explicitly.

## Verified infrastructure

Mainnet 4663 (0x1237), ETH gas, public RPC https://rpc.mainnet.chain.robinhood.com, explorer https://robinhoodchain.blockscout.com. Testnet 46630 remains available but is not the primary destination.

- PoolManager: `0x8366a39cc670b4001a1121b8f6a443a643e40951`
- WETH: `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
- USDG: `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`
- USDC: unset; never silently substituted or misidentified.

Per Jesse's latest decision, USDG is Robinhood's reference asset. The existing contract/manifest key `usdc` binds USDG on that chain; this is an ABI-compatible legacy field, not a claim that USDG is USDC. Robinhood-facing availability, landing and pass-payment UI labels it USDG. The retained explicit legacy simulation and other-chain screens still contain USDC labels; those are not a live Robinhood integration certification.

Read-only JSON-RPC verification on November 7, 2026: `eth_chainId` returned `0x1237`; `eth_call` to USDG with `decimals()` selector `0x313ce567` returned 6. No signing, sending, funding, launch or private keys were used.

Sources:
- https://docs.robinhood.com/chain/connecting/
- https://docs.robinhood.com/chain/contracts/
- https://developers.uniswap.org/deployments
- https://github.com/Uniswap/contracts/blob/main/deployments/4663.md

RH logo is an explicit TODO placeholder, not the documentation social-preview image. Expansion icons are local monograms, likewise not claimed to be official brand assets.

## Independent Genesis NFT sale

`MasonryGenesisPass.saleOpen` defaults false. Only the immutable `schedule.scheduler()` authority can call `setSaleOpen(bool)`, emitting `SaleOpenChanged`. Purchase and pay-the-difference upgrade require the switch open. An unscheduled end (0) permits sales; any scheduled end is a strict cutoff, regardless of the switch. Closing the switch stops both operations. Staking/Ultra early access logic is unchanged.

The Admin sale panel checks scheduler authority, reads current state and uses the existing simulate/re-check-account-and-chain/confirm/receipt action flow. Without a verified deployment, it is unavailable except explicitly simulated preview. Purchase cards show Sale not open yet when closed and offer only upward upgrades. ABI files come from the locally compiled artifact.

## Outstanding

No verified protocol launch exists. Real contract graph, pool funding, operational ownership and end-to-end live writes remain pending. Existing legacy Treasury/Farm integration limitations remain. This work does not reconcile pre-existing frontend economic preview formulas with the separate local Solidity tax-curve commits.

## Validation (November 7, 2026, EST)

- Frozen pnpm install passed using `COREPACK_HOME=/home/box/.cache/corepack` (system cache is not writable).
- Frontend typecheck and production build passed. Vite retains dependency PURE-annotation and >500 kB chunk warnings.
- Full Playwright suite: 77 passed across model, desktop and mobile. Includes missing-chain add/switch fallback, rejected switches without retries, no transaction requests, sale toggle simulation and 320px gate layout.
- Full local Foundry suite: 411 passed, 0 failed, 7 network-dependent tests skipped. No live fork endpoint was supplied.
- Deployment/network schema tests: 35 passed.
- `git diff --check` passed.
- Screenshots: `/workspace/v4-assess/shots/chain-dropdown-desktop.png`, `chain-dropdown-mobile.png`, `coming-soon-base-desktop.png`, `coming-soon-base-mobile.png`.

No real-network write, launch, push or private-key use occurred.
