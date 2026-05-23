# Old Money frontend

Vite + React + TypeScript + Tailwind + Wagmi/Viem.

Design grammar: 1980s Miami Vice / Memphis Group / Arcade. See `Desktop\Design\files\skill-eighties.md` for the design language and `tailwind.config.ts` for the palette modes.

## Setup

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The landing page should render with the chrome OLD MONEY hero, diagonal pink band, and night-ground cards below.

## Env vars

Create `frontend/.env.local`:

```
VITE_BASE_RPC_URL=https://your-base-rpc
VITE_BASE_SEPOLIA_RPC_URL=https://your-base-sepolia-rpc
```

Defaults to public endpoints if unset (rate-limited).

## Scripts

- `npm run dev` — Vite dev server on :5173
- `npm run build` — TypeScript check + production build to `dist/`
- `npm run preview` — preview the production build
- `npm run typecheck` — type check only, no emit

## Structure

```
frontend/
├── index.html         — fonts (Oswald, Roboto Slab) + meta tags
├── tailwind.config.ts — palette modes, shadows, fonts, animation
├── src/
│   ├── main.tsx       — Wagmi + React Query providers, routes
│   ├── styles/
│   │   └── index.css  — Tailwind layers + eighties components
│   ├── theme/         — palette helpers (TBD)
│   ├── components/
│   │   ├── MemphisScatter.tsx — background shape layer
│   │   └── ConnectButton.tsx  — wallet connect
│   ├── routes/
│   │   └── Landing.tsx        — Miami Vice Split hero page
│   └── lib/
│       └── wagmi.ts           — chain + transport config
```

## Status

- ✅ Project bootstrap
- ✅ Eighties design system (Tailwind palette modes, CSS components)
- ✅ Landing page (Miami Vice Split: chrome hero + diagonal + night-ground 3-card)
- ✅ Wallet connect (injected/MetaMask)
- ⏳ Dashboard (epoch state, price, supply) — next sprint
- ⏳ TheClub (Boardroom staking) — next sprint
- ⏳ TheVault (reward pools) — next sprint
- ⏳ TrustNotes (bond buy/redeem) — next sprint
- ⏳ Swap (V4 pool) — next sprint
