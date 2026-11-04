# xTOMB frontend

React, TypeScript, Vite, Wagmi and Viem. The xTOMB application entry point is `src/main.tsx`. Its Obsidian Crypt theme is based on the supplied xTOMB-UX preview. The React source and styling live in `src/xtomb/`, and the theme’s three local font assets live in `public/fonts/`.

```sh
npm ci
npm run dev
npm run build
npm run test:browser
```

The app includes the dashboard, Genesis, Farm, Masonry, Swap and the protocol guide. The dashboard and Fire Tax tools use explicitly labeled sample values. Genesis membership prices, timing, fees and routing percentages are derived from `../config/masonry-launch.template.json`.

Wagmi uses the existing network manifest for injected-wallet connection and switching. This interface does not use legacy deployment addresses for xTOMB transactions. A verified xTOMB deployment manifest and contract bindings are required before enabling live prices, balances, NFT minting, staking or swaps. Farm staking and migration remain pending on the backend.
