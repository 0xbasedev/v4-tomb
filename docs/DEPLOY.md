# Configure and deploy

Run tooling from the repository root except Foundry commands, which run from `contracts/`. These instructions supersede chain-specific commands in historical runbooks and script headers.

## 1. Configure a compatible chain

Edit `config/networks.json`. Each network defines:

- `id`, `name`, `testnet`, and 18-decimal native gas-currency metadata;
- a browser-accessible public `rpcUrl`, and `explorerUrl` or `null`;
- `infrastructure`: trusted `weth`, V4 `poolManager`, V4 `positionManager`, `permit2`, `universalRouter`, and `create2Deployer` only for historical CREATE2 deployments;
- `create3` holds the predicted project addresses, authorized deployer, release ID, factory and mined hook nonce.
- `deployment` stays `null` until publication verifies the completed broadcast.

Project addresses come from the release plan. Third-party infrastructure addresses come from the selected network. Select an 18-decimal WETH asset to preserve the economic denomination. Do not substitute a chain's wrapped native token if it is not the intended WETH peg asset. Native gas currency metadata is independent of the peg.

Do not put private RPC credentials in the public manifest; it is bundled into the frontend. Operators can override their RPC privately with `RPC_URL`. A browser RPC needs appropriate CORS support.

```sh
node scripts/protocol.mjs validate
node scripts/install-contract-deps.mjs
```

To inspect the old deployment, copy `config/examples/upstream-base-sepolia.json` over `config/networks.json` and rebuild the frontend. That profile is historical and is not evidence that its contracts remain safe or active.

## 2. Plan project addresses

Create a release JSON from `config/create3-release.template.json`. Set a unique nonzero 32-byte `releaseId`, the actual deployment signer address, and the Wizard-selected chain ID as `canonicalDomain`. Keep the reviewed plan fixed across deployment and publication. Use a new release ID if a different configuration needs its own addresses.

```sh
npm --prefix frontend ci
node scripts/create3.mjs core config/networks.json config/release.json config/core.release.json 0
```

Select the generated `config/core.release.json` with `PROTOCOL_CONFIG`. The planner is offline. It predicts all 13 project addresses from CreateX, release ID, signer and role, including a salt whose hook address has the required V4 permission bits. The same release, signer and role produce the same address on each chain where the canonical factory is deployed. The factory address and runtime hash are pinned. [CreateX](https://github.com/pcaversaccio/createx/blob/6aa175d8ab30de8159199c8d7efa6d82ecbd5769/README.md)

## 3. Set operator parameters

```sh
cd contracts
cp .env.example .env
# Fill in RPC_URL, signer, nonzero recipient wallets, TIMELOCK_ADMIN,
# and explicit future VESTING_START and EPOCH_START. Never commit .env.
set -a
source .env
set +a
```

`PROTOCOL_NETWORK_INDEX` is the zero-based manifest index (default 0). `PROTOCOL_CONFIG` defaults to `../config/networks.json`; custom files must be under the allowed public config directory. The frontend selects the same `PROTOCOL_CONFIG` path (relative to `frontend/`); by default it uses `../config/networks.json`. Set that variable when building or starting the UI. The CLI also honors it, or accepts an explicit manifest path. Browser tests always use the isolated local example profile.

The main deploy creates tokens, hook/pool, oracle, wrapper, three funded reward pools, Treasury, Boardroom, MiniSwapRouter, and Timelock. It wires Treasury token authority and the Main/Share wrapper pools. It leaves Genesis token registration, seed liquidity, Boardroom seeding, tax enablement/fund cuts, and governance rotation to the launch ceremony.

## 4. Simulate, review, broadcast

```sh
forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --slow
# Review addresses, starts, fund recipients, Timelock admin/delay and transactions.
forge script script/Deploy.s.sol --rpc-url "$RPC_URL" --broadcast --slow
```

Preflight checks the selected chain ID, dependency code, 18-decimal WETH, and PositionManager bindings before broadcasting. The script checks every planned CREATE3 address before broadcasting. The hook checks the approved initializer and binds the pool when initialized.

The script writes `deployment-output/<chainId>.json`. It is a simulation artifact until broadcast receipts confirm. A failed or partial broadcast is not a usable deployment: inspect receipts and Foundry resume behavior before retrying. Do not publish a mixture of outputs from different deploy attempts.

## 5. Publish confirmed addresses

From the repository root, replace `<chainId>` and `<index>` with your selected profile:

```sh
node scripts/protocol.mjs publish config/core.release.json \
  contracts/deployment-output/<chainId>.json \
  contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json <index>
(cd frontend && npm run build)
```

The publisher checks RPC chain ID, successful mined receipts, the authorized signer, factory runtime hash, exact CreateX proxy and contract creation events, and code at every configured deployment address. `deployBlock` is derived from the earliest confirmed broadcast receipt and stored as a decimal string to avoid JavaScript number precision loss. Review the resulting manifest before committing it.

## 6. Finish the existing launch ceremony

All operational scripts now read protocol addresses from the manifest, not legacy `MONEY`, `TREASURY`, `HOOK`, or `TIMELOCK` environment variables. Amounts, weights, signers, fund policy, ETA and other operation-specific inputs remain explicit environment variables as documented in each script. Set the correct `PROTOCOL_NETWORK_INDEX` and RPC each time.

Use `OpenGenesis.s.sol` for allowed stake tokens and weights; `SeedLiquidity.s.sol` for funded seed LP; `PostBootstrap.s.sol` for the existing tax/fund transition; and `RotateGovernanceQueue.s.sol` / `RotateGovernanceExecute.s.sol` for delayed ownership rotation. Standalone router/Timelock deploy scripts remain available for deliberate replacements; they are unnecessary for a fresh main deploy, and replacement addresses must be reviewed in the manifest. Consult the preserved launch/governance runbooks for the complete existing ceremony.

## Masonry components

The modern Masonry release has a separate plan. Its hooks, oracles, defense contract, vaults, and other components receive independent addresses. The oracle uses the predicted hook address in its constructor. Each hook checks the supplied oracle and its configured Pool ID before deployment succeeds.

```sh
node scripts/create3.mjs masonry - config/release.json config/masonry.release.json
```

Review the compiled creation bytecode plus encoded constructor arguments for each intended component. Record the Keccak-256 of those bytes in `masonryInitCodeHashes` by role in the release JSON and generate a reviewed plan in a new output file. `DeployMasonryComponent.s.sol` requires the hash, expected address and chain before it will deploy that component. Configure and dry-run the complete dependency order, token economics, pool initialization, and role wiring for the chosen launch before broadcasting. The component deployer is not a one-shot launch orchestrator.

For the Genesis schedule constructor, use `MasonryGenesisSchedule(genesisStart, governance)` from the launch settings. A start of `0` defers scheduling. After deploying and wiring the Genesis contracts and funding the staking contract, use Admin to check readiness and submit `schedule(uint256)` from the governance wallet. A governance contract can execute the same call through its own transaction flow. The start can be set once and must be in the future. A nonzero constructor date sets the clock at deployment. The constructor changed, so regenerate and review the schedule's creation-code hash before deploying.

```sh
MASONRY_CREATE3_CONFIG=../config/masonry.release.json \
  forge script script/DeployMasonryComponent.s.sol --rpc-url "$RPC_URL" --account "$DEPLOYER_ACCOUNT" \
  --sig 'run(string,bytes)' "$ROLE" "$APPROVED_INITCODE"
```

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
