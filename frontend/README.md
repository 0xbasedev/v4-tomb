# xTOMB frontend

React, TypeScript, Vite, Wagmi and Viem. The xTOMB application entry point is `src/main.tsx`. Its Obsidian Crypt theme is based on the supplied xTOMB-UX preview. The React source and styling live in `src/xtomb/`, and the theme’s three local font assets live in `public/fonts/`.

```sh
npm ci
npm run dev
npm run build
npm run test:browser
```

The app includes the dashboard, Genesis, Farm, Masonry, Swap, xSHARE Bridge and the protocol guide. The dashboard and Fire Tax tools use explicitly labeled sample values. Genesis membership prices, timing, fees and routing percentages are derived from `../config/masonry-launch.template.json`.

Wagmi uses the existing network manifest for injected-wallet connection and switching. This interface does not use legacy deployment addresses for xTOMB transactions. A verified xTOMB deployment manifest and contract bindings are required before enabling live prices, balances, NFT minting, staking or swaps. Farm staking and migration remain pending on the backend.


## Release tools

- Open `/wizard` to choose the home network, enter verified infrastructure and public operator addresses, and configure the launch supply, vesting, and optional xSHARE bridge. Contract rules such as the seven-day Genesis window and the 12% Fire Tax cap are shown as fixed protocol settings.
- The Wizard calculates the same CREATE3 predictions as the deployment CLI in a browser worker. It saves a draft in this browser and exports separate release inputs, launch settings, Masonry addresses, and an optional disabled bridge manifest. Use public RPC URLs and addresses in drafts. Keep private RPC credentials and keys in the deploy environment.
- Open `/admin` to import a draft or load the saved draft. Admin can pin a block, reject a mismatched RPC chain ID, verify the CreateX factory runtime hash, and report code presence at infrastructure and predicted contract addresses. This is a read-only review. Code presence does not verify ownership, constructor arguments, or production route readiness.
- Follow [the deployment runbook](../docs/DEPLOY.md) for reviewed constructor inputs and deployment. [Bridge activation](../docs/XSHARE_BRIDGE.md) requires verified peers, verifiers, and live round trips. The public Bridge page keeps all five routes disabled in this build.

The supplied v5 archive is a compiled reference. The release tools use editable React source with its Obsidian Crypt palette, typography and xTOMB mark.
