# xTOMB and xSHARE

The `merge` branch contains the xTOMB and xSHARE frontend preview and the in-progress Masonry contracts. See the [frontend guide](frontend/README.md) and [integration status](docs/MASONRY_V4_IMPLEMENTATION_STATUS.md) for the active work. The deployment runbook and legacy network manifests below still target the inherited Old Money contracts.

## Inherited Old Money tooling

A full-stack fork of [0xbasedev/v4-tomb](https://github.com/0xbasedev/v4-tomb) at `0146a18a2e0f1c4c48a85b48879f67c6c971b7b6`. It preserves MONEY / ESTATE / TRUSTNOTE, WETH peg, Treasury seigniorage and bonds, Boardroom staking, Genesis / Main / Share reward pools, the fourteen-tier Uniswap V4 hook, swaps, LP wrapping, governance tooling, and the Art Deco React interface.

Chain dependencies now come from a shared, validated [network manifest](config/networks.json). Supported targets are **Cancun-compatible EVM chains with compatible V4 infrastructure and an 18-decimal WETH peg asset**. This is not a Solana port or a change to the original economics. No Masonry-specific tiers, taxes, or Genesis NFT policies have been added.

## Start locally

Requirements: Node 22+, Git, Foundry v1.8.7. From the repository root:

```sh
node scripts/install-contract-deps.mjs
node scripts/protocol.mjs validate
node --test config/schema.test.mjs
(cd contracts && forge test)
(cd frontend && npm ci && npm run build && npm run dev)
```

The default profile is a local chain with no deployment. The xTOMB frontend is browsable and supports injected-wallet connection and switching among configured networks. It needs a verified xTOMB deployment and its own contract bindings before it can submit transactions.

## Deploy a new instance

Follow [DEPLOY.md](docs/DEPLOY.md). Edit public dependencies once in `config/networks.json`; the frontend, deploy scripts, operational scripts, and keeper use this manifest. Protocol addresses are exported by the deploy script and published into the manifest only after checking broadcast receipts and deployed code. There are no chain-address switches in production Solidity or TypeScript.

Set `PROTOCOL_CONFIG=../config/your-profile.json` when starting/building the frontend or running Foundry from their respective directories to use another public manifest.

An explicitly selectable [historical Base Sepolia profile](config/examples/upstream-base-sepolia.json) preserves the upstream configuration as a reference. It is not loaded by default, has not been revalidated against live chain state, and must not be mistaken for a new deployment.

## Architecture and review

- [Architecture and preservation map](docs/ARCHITECTURE.md)
- [Configuration and deployment workflow](docs/DEPLOY.md)
- [Change review and measured verification](docs/PORTABILITY_REVIEW.md)
- [Upstream README](docs/UPSTREAM_README.md), preserved as historical documentation
- Existing economic design and audit documents remain under `docs/`; their historical audit/deployment claims do not certify this branch.

`contracts/dependencies.json` pins Solidity dependencies by commit. `frontend/package-lock.json` pins the UI dependency graph. Measured local verification: **331 contract tests, 29 configuration tests, and 4 browser tests passed**.

CI builds and tests both layers, with deeper invariants scheduled nightly. Keeper execution requires explicit repository opt-in and a configured environment; no keeper or live deployment was activated by this change.

License: existing BUSL-1.1 and third-party licenses are retained.
