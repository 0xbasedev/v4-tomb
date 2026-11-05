# Configure and deploy

Run tooling from the repository root except Foundry commands, which run from `contracts/`. These instructions supersede chain-specific commands in historical runbooks and script headers.

## 1. Configure a compatible chain

Edit `config/networks.json`. Each network defines:

- `id`, `name`, `testnet`, and 18-decimal native gas-currency metadata;
- a browser-accessible public `rpcUrl`, and `explorerUrl` or `null`;
- `infrastructure`: trusted `weth`, V4 `poolManager`, V4 `positionManager`, `permit2`, `universalRouter`, and a salt || initCode compatible `create2Deployer`;
- `deployment`: `null` before deployment, or the complete address record afterward.

Addresses are configuration data, never Solidity/TypeScript constants. Select an 18-decimal WETH asset to preserve the economic denomination. Do not substitute a chain's wrapped native token if it is not the intended WETH peg asset. Native gas currency metadata is independent of the peg.

Do not put private RPC credentials in the public manifest; it is bundled into the frontend. Operators can override their RPC privately with `RPC_URL`. A browser RPC needs appropriate CORS support.

```sh
node scripts/protocol.mjs validate
node scripts/install-contract-deps.mjs
```

To inspect the old deployment, copy `config/examples/upstream-base-sepolia.json` over `config/networks.json` and rebuild the frontend. That profile is historical and is not evidence that its contracts remain safe or active.

## 2. Set operator parameters

```sh
cd contracts
cp .env.example .env
# Fill in RPC_URL, signer, nonzero recipient wallets, TIMELOCK_ADMIN,
# and optionally explicit future launch times. Never commit .env.
set -a
source .env
set +a
```

`PROTOCOL_NETWORK_INDEX` is the zero-based manifest index (default 0). `PROTOCOL_CONFIG` defaults to `../config/networks.json`; custom files must be under the allowed public config directory. The frontend selects the same `PROTOCOL_CONFIG` path (relative to `frontend/`); by default it uses `../config/networks.json`. Set that variable when building or starting the UI. The CLI also honors it, or accepts an explicit manifest path. Browser tests always use the isolated local example profile.

The main deploy creates tokens, hook/pool, oracle, wrapper, three funded reward pools, Treasury, Boardroom, MiniSwapRouter, and Timelock. It wires Treasury token authority and the Main/Share wrapper pools. It leaves Genesis token registration, seed liquidity, Boardroom seeding, tax enablement/fund cuts, and governance rotation to the launch ceremony.

## 3. Simulate, review, broadcast

```sh
forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --slow
# Review addresses, starts, fund recipients, Timelock admin/delay and transactions.
forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --broadcast --slow
```

Preflight checks the selected chain ID, dependency code, 18-decimal WETH, and PositionManager bindings before broadcasting. CREATE2 deployment calls the configured factory directly; no Foundry default factory address is assumed. The hook's mined address must encode the existing V4 permissions, and pool initialization binds it.

The script writes `deployment-output/<chainId>.json`. It is a simulation artifact until broadcast receipts confirm. A failed or partial broadcast is not a usable deployment: inspect receipts and Foundry resume behavior before retrying. Do not publish a mixture of outputs from different deploy attempts.

## 4. Publish confirmed addresses

From the repository root, replace `<chainId>` and `<index>` with your selected profile:

```sh
node scripts/protocol.mjs publish config/networks.json \
  contracts/deployment-output/<chainId>.json \
  contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json <index>
(cd frontend && npm run build)
```

The publisher checks RPC chain ID, successful mined receipts, deployed contract addresses against their creation receipts, and code at every configured deployment address. `deployBlock` is derived from the earliest confirmed broadcast receipt and stored as a decimal string to avoid JavaScript number precision loss. Review the resulting manifest before committing it.

## 5. Finish the existing launch ceremony

All operational scripts now read protocol addresses from the manifest, not legacy `MONEY`, `TREASURY`, `HOOK`, or `TIMELOCK` environment variables. Amounts, weights, signers, fund policy, ETA and other operation-specific inputs remain explicit environment variables as documented in each script. Set the correct `PROTOCOL_NETWORK_INDEX` and RPC each time.

Use `OpenGenesis.s.sol` for allowed stake tokens and weights; `SeedLiquidity.s.sol` for funded seed LP; `PostBootstrap.s.sol` for the existing tax/fund transition; and `RotateGovernanceQueue.s.sol` / `RotateGovernanceExecute.s.sol` for delayed ownership rotation. Standalone router/Timelock deploy scripts remain available for deliberate replacements; they are unnecessary for a fresh main deploy, and replacement addresses must be reviewed in the manifest. Consult the preserved launch/governance runbooks for the complete existing ceremony.

## Keeper

Set repository variable `KEEPER_ENABLED=true` only after the deployment and launch ceremony are approved. Configure the GitHub environment `keeper` with `RPC_URL`, `KEEPER_PRIVATE_KEY`, and `PROTOCOL_NETWORK_INDEX`. Use a signer with gas only and no privileged roles. The workflow resolves Treasury from the manifest and rejects a chain mismatch. It is disabled unless explicitly opted in. Additional chain instances can use separate environment-bound keeper jobs with distinct signers and manifests.

## Verification

```sh
node --test config/schema.test.mjs
(cd frontend && npm ci && npm run build)
(cd frontend && npx playwright install chromium && npm run test:browser)
(cd contracts && forge fmt --check && forge test)
(cd contracts && FOUNDRY_PROFILE=ci forge test)
# Optional historical live-chain coverage:
(cd contracts && BASE_RPC_URL=<your-base-rpc> forge test --match-path 'test/integration/BaseFork*.t.sol')
```

Local deployment tests use a real V4 PoolManager with mocked peripheral views on chain IDs 777 and 888. They verify hook permissions/binding, Treasury roles, reward funding, auxiliary contracts, and artifact export. They do not substitute for a target-chain dry run, external security audit, governance review, or live-wallet transaction testing.
