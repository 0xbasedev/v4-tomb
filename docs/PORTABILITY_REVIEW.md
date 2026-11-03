# Portability review and measured verification

Date: 2026-11-03. Base: `0146a18a2e0f1c4c48a85b48879f67c6c971b7b6`. Branch: `feat/chain-agnostic-config`.

## Review scope and verdict

The implementation received an author self-review using the engineering code-review checklist: correctness, security boundaries, races, performance, maintainability, and test coverage. This is not an independent review, external security audit, or deployment certification. Verdict: ready for maintainer review as a draft PR; not a production launch approval.

The protocol's deployed runtime implementations and economic constants were preserved. The production address registry was removed from `src` and retained as historical test fixtures. New logic is in deployment/configuration tooling and the frontend. Five pre-existing test files were normalized to satisfy the pinned Foundry formatter; those formatting changes do not alter assertions or protocol behavior.

## Findings resolved during implementation

| Area | Finding | Resolution |
| --- | --- | --- |
| Chain configuration | Source-level address switches and a Base-only wallet registry | Shared validated public JSON, chain guard in every operational script, configurable frontend profiles |
| Hook deployment | A fixed factory address could disagree with hook salt mining | Mine and directly call the configured salt || initCode factory; bind through real V4 initialization |
| Dependency integrity | Moving Solidity dependency branches and no complete installer | Exact revision lock and recursive dependency installer, pinned Foundry toolchain in CI |
| Deployment publication | Simulation addresses could be copied into a live frontend | Require matching chain IDs, completed successful receipts, creation-address correspondence, and contract code |
| Pool state | Exchange reserve labels assumed WETH sorts first | Derive reserve ownership from address ordering; tests cover both orders |
| React polling | Constructing fresh deployment objects restarted dependent effects | Stable deployment map and clearing event state on deployment/client changes |
| Wallet context | Cached supported chain could be used for an unsupported wallet | Resolve connected wallet chain explicitly; unsupported/unconfigured network status and action gating |
| Transaction context | Approval pipelines and receipt polling could drift after a network/account change | Pin write/receipt chain IDs, check original wallet before each pipeline signature, reset old mutation results, and keep allowance checks in the in-flight state |
| Explorer links | Links always targeted Base Sepolia | Manifest-selected explorer, with toast origin preserved across network changes |
| Operations | Keeper workflow baked in Base targets | Explicit opt-in keeper with environment-bound RPC/signer/index and manifest Treasury resolution |

## Verification performed

Environment: Node 22.22.3, npm 10.9.8, Foundry v1.8.7, Solidity 0.8.26, Cancun EVM.

| Check | Result |
| --- | --- |
| Baseline before changes, default Foundry profile | 291 passed, 0 failed, 6 skipped |
| Updated default Foundry profile, no external RPC | 301 passed, 0 failed, 6 skipped |
| Updated CI profile, no external RPC | 301 passed, 0 failed, 6 skipped |
| Final CI profile with Base RPC, all suites together | **331 passed, 0 failed, 0 skipped** |
| Historical Base fork suites separately | 30 passed; included in the final 331, not additional tests |
| Shared schema, publisher, explorer, currency-order tests | **29 passed** |
| Playwright tests | **4 passed**: all eight routes at desktop/mobile widths, mock wallet network switch with no transaction requests, wallet-session identity checks |
| Frontend TypeScript and Vite production build | Passed |
| Foundry formatting | Passed |
| Production contract runtime-size check | Passed with `forge build --sizes --skip test --skip script` |
| Default and historical example manifest validation | Passed |
| Pinned dependency installer and JavaScript syntax checks | Passed |
| Diff whitespace check | Passed |

The new deployment tests initialize a real local V4 PoolManager on chain IDs 777 and 888, deploy through a test CREATE2 factory, check hook permissions/binding and operator roles, assert Genesis/Main/Share funding, check router and Timelock, and inspect exported addresses. Peripheral contract views are mocked in those tests. Historical fork suites additionally exercised real Base V4 dependencies using `https://mainnet.base.org` at the RPC's then-current head; that block was not pinned, so a later rerun can observe different chain state.

The browser suite uses an isolated unconfigured local manifest and a mock injected wallet. It does not execute funded live-wallet transactions or simulate every approval pipeline against a deployed target instance.

## Dependency follow-up

1. Frontend production dependencies now audit clean: `cd frontend && npm audit` reports 0 vulnerabilities. Wagmi 3 keeps wallet-connector SDKs optional, and the app imports only `wagmi/connectors/injected`, so the Coinbase, WalletConnect, and MetaMask SDK trees are not installed. Vite 7 and React Router 7 replace the previously flagged releases. Zod is overridden to 4.6.7 because abitype's optional peer otherwise installs a vulnerable 3.x release; application code does not import Zod. Re-run the audit after any dependency change.
2. Routes load on demand, and the production build splits Viem and Wagmi into their own chunks. The largest chunk is Viem at about 283 kB uncompressed, under Vite's 500 kB warning. The previous single chunk was about 718 kB.

Follow-up checks: TypeScript and the Vite production build passed, schema tests passed (29), and the four Playwright tests passed, including both viewport widths and the mock-wallet network switch.

## Remaining release work and limitations

1. Foundry emits runtime/test lint warnings inherited from the source. This work did not run a new Slither campaign or exhaustively re-audit the economic contracts. All pre-existing security/audit documents remain historical context.
2. Select and review the actual target chain, compatible third-party dependency bytecode, recipient/admin wallets, launch timestamps, Genesis stake tokens, seed liquidity, and governance rotation. The manifest code checks establish basic compatibility, not trustworthiness of arbitrary infrastructure.
3. Run a full target-chain simulation and an independent security review before deployment. No funded deployment, governance rotation, keeper activation, frontend hosting deployment, or PR merge was performed.
4. Scope is compatible Cancun EVM chains with an 18-decimal WETH peg asset and the existing V4 design. Different virtual machines, assets, tokenomics, NFT tiers, or AMMs are separate design changes. The upstream unavailable ESTATE/WETH tab remains unavailable.
