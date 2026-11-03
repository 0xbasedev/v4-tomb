# Architecture and preservation map

Source baseline: `0146a18a2e0f1c4c48a85b48879f67c6c971b7b6` (main, inspected before implementation).

## Protocol

The smart contracts are the backend. The React client reads RPC state and sends wallet-signed transactions; the keeper submits the existing permissionless epoch allocation call. There is no server-held user key or new off-chain balance database.

| Component | Existing role | Change in this branch |
| --- | --- | --- |
| OldMoney, Estate, TrustNote | Stable / capped share / bond | Runtime source unchanged |
| Treasury | Expansion, bootstrap, contraction, debt caps, bond office | Runtime source unchanged |
| Boardroom | ESTATE staking and MONEY claims with epoch locks | Runtime source unchanged |
| Genesis / Main / Share pools | MasterChef reward distribution | Runtime source unchanged; deployment still funds and wires all three |
| PegDefenseHook / Oracle | Fourteen-tier sell tax and V4 tick TWAP | Runtime source unchanged; hook factory and dependencies selected from config |
| V4PositionWrapper | Full-range position NFT receipts for reward staking | Runtime source unchanged |
| MiniSwapRouter | V4 exact-input swap settlement | Runtime source unchanged; now included in the main deploy |
| Timelock / Trustees | Administrative authority and delayed rotation | Runtime source unchanged; main deploy creates Timelock but rotation remains an explicit ceremony |
| React routes | Dashboard, Club, Vault, Notes, Exchange, Admin, Docs | Preserved; configured wallets/explorers, corrected currency ordering, unsupported-wallet-chain gating, wallet-session checks and pinned receipt polling |
| Operational scripts | Genesis registration, liquidity, bootstrap, keeper, governance | Shared network/contract resolution with a chain-ID guard |

`contracts/src/libs/Addresses.sol` was a chain-address registry used by scripts and fork tests. Its historical content is retained only in `contracts/test/fixtures/HistoricalAddresses.sol`; production contracts have no replacement address registry.

## Configuration flow

`config/networks.json` → shared schema validator → frontend chains / RPC / deployment reads / explorer URLs.

The same JSON is read by `contracts/script/NetworkConfig.s.sol`, using `PROTOCOL_CONFIG` and `PROTOCOL_NETWORK_INDEX`. Each operation checks the actual RPC chain before resolving contracts. The deploy preflight rejects absent dependency code, incorrect WETH decimals, and mismatched PositionManager PoolManager/Permit2 bindings.

`Deploy.s.sol` → local simulation artifact → completed Foundry broadcast → `scripts/protocol.mjs publish` → complete deployment manifest → frontend rebuild.

Publication checks chain IDs, successful receipts for every recorded transaction, contract-creation receipt addresses, and deployed code. These checks establish deployment provenance, not the safety of third-party infrastructure. Operators must select trusted, compatible dependency bytecode. The configured CREATE2 factory must implement the salt || initCode interface; hook deployment and V4 initialization are simulated before broadcast.

## Deliberate limits

- The WETH peg and 18-decimal price assumptions remain intact. Other peg assets, denominations, token brands, epoch economics, and AMMs require separate protocol changes and review.
- Cancun opcodes and a compatible Uniswap V4 stack are required. “Chain-agnostic” does not mean arbitrary virtual machines or arbitrary router implementations.
- The upstream ESTATE/WETH Exchange tab remains an unavailable pool placeholder; this branch does not silently create a new trading market.
- Historical Base fork suites retain historical fixture addresses. They remain opt-in with `BASE_RPC_URL`; they are not dependencies of the production configuration.
- Governance rotation, seed liquidity, Genesis token selection, Boardroom seeding, and launch approval remain deliberate operator steps. Creating a Timelock does not transfer authority to it.
