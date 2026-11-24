# xTOMB frontend

React, TypeScript, Vite, wagmi/viem, Tailwind and GSAP. It talks to the contracts in `../contracts/src` and to nothing else.

```sh
pnpm install --frozen-lockfile
pnpm dev            # validates ../config/networks.json first
pnpm build          # tsc (noUnusedLocals / noUnusedParameters) + vite build
pnpm test:browser   # Playwright, against the shipped manifest
pnpm gen:abis       # after `forge build` in ../contracts: rebuild src/lib/abis/protocol.ts
```

On-screen names: **xTOMB** (PegToken), **xSHARE** (ShareToken), **xROOM** (the Masonry). Token symbols are read from chain when a deployment exists and fall back to these names. The paired asset is never named in static copy; its symbol is read from chain.

## Where the data comes from

| Layer | File | Source |
| --- | --- | --- |
| Networks and deployments | `src/lib/networks.tsx`, `src/lib/addresses.ts` | `../config/networks.json`, validated by `../config/schema.mjs` |
| Reads | `src/lib/hooks/useProtocol.ts` (`ProtocolState`), `useFarm.ts`, `useRoles.ts`, `useV4Position.ts` | Treasury, PegDefenseHook, ShareBuybackHook, Masonry, the three reward pools, PoolManager `extsload` |
| Writes | `src/lib/hooks/useActions.ts` | Masonry, reward pools, MiniSwapRouter, PositionManager + Permit2, V4PositionWrapper, the three permissionless hook calls |
| Network state | `src/lib/hooks/useNetworkStatus.ts` | wallet chain vs the manifest |
| Fixed rules shown as "Contract rule" | `src/lib/protocol.ts` | constants and constructor defaults copied from the contracts |

`PROTOCOL_CONFIG=<path> pnpm dev` points a dev server at another manifest (for example a local fork's). `VITE_RPC_<chainId>` overrides a network's RPC URL.

## What is live, and what needs a deployment

**The shipped manifest has `deployment: null`.** With no deployment the app renders every page, says "Not deployed on this network", shows dashes instead of numbers and disables every action with the reason. It has no preview or sample-data mode: nothing on screen is simulated.

Always live (static, from the contracts' constants): the sell-tax schedule, epoch length, lockups, emission totals and schedules, the Docs page.

Needs a deployment in `config/networks.json`:

| Page | Reads | Writes |
| --- | --- | --- |
| Landing, Dashboard | TWAP, ceiling, epoch clock, next expansion and fund cuts (Treasury); tax rate, ratchet, deferred tax, totals (PegDefenseHook); buyback status and totals (ShareBuybackHook); supplies; the three pools' price, tick and liquidity | none |
| Genesis | GenesisRewardPool: window, pools, your deposit and earnings | `deposit`, `withdraw`, claim (`deposit(pid, 0)`), `emergencyWithdraw` |
| Farm | PegFarm and ShareFarm pools; wrapper balances; position NFTs | the same four calls; mint a full-range position (Permit2 + `modifyLiquidities`), `wrap`, `unwrap`, remove liquidity |
| xROOM (`/masonry`) | stake token (`share()`), totals, your stake, earned, `canWithdraw`, `canClaimReward`, lockup epochs | `stake`, `withdraw`, `claimReward`, `exit` |
| Swap | pool state, `currentTaxRate`, tax switches, the hook's LP-fee band | `MiniSwapRouter.swapExactIn` with a deadline, for xTOMB and xSHARE against the paired asset |
| Status (`/admin`) | operator / owner / trustees of every contract against the Timelock; Timelock admin and delay; tax switches; pending deferred tax and buyback | `pokeTaxRate`, `settleDeferredTax`, `executeBuyback` (permissionless) |

Every write goes through one pipeline in `useActions.ts`: exact-amount approvals only when the allowance is short, a simulation before each signature, a check that the wallet account and chain have not changed since the flow began, then the receipt.

Not verified against a live chain in this change: no deployment exists to test against. The read and write paths were exercised only against a mocked RPC, so treat the first run against a real fork as the real test — in particular the Permit2 mint flow, the `extsload` storage slots, and the swap output estimate.

## What was removed

The supplied frontend was built for a different contract system. These had no counterpart in this repository and were deleted, with their components, hooks, config imports and tests: the auction / share sale, the cross-chain page, the deploy wizard and launch manager, pass-gated Genesis and the multi-pool vesting Genesis, the auto-compounder and keeper, the zap, the preview/sample-data mode, and the `Masonry*` ABIs. Old paths redirect: `/club` → `/masonry`, `/vault` and `/farms` → `/farm`, and the paths of removed features → `/dashboard`.

## Theme

Colour tokens live in one place, `:root` in `src/styles/index.css`; `tailwind.config.ts` only maps names onto them. The accent is a dark gradient — deep violet `#7c3aed` → indigo `#4f46e5` → electric blue `#3b82f6` — on a near-black ground `#050507`. State colours are green (ok), orchid (warn) and rose (bad). No warm hue is used; a Playwright test scans every route's computed colours to keep it that way. Motion is GSAP (`src/lib/motion`) and stands still under `prefers-reduced-motion`.
