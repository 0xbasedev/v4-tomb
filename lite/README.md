# xTomb Lite: Chain-agnostic DeFi core (review branch)

**Status: source integrated, not audited, not deployed. Build/tests must pass in CI before signing.**

This is a self-contained V2-compatible execution profile for chains without a verified Uniswap V4 PoolManager, including candidate LONGYU Testnet. Network addresses, prices, chain ID, LPs, reserve floors, DEX fees, schedules and allocations are DATA provided by `config/release.json`, never compiled in as chain IDs or router addresses.

The production-oriented components have replaced the original LONGYU-only mock prototype. They are **not production-approved** until adversarial tests, real pair/factory verification, stable/USD feed provenance, contract audit, keeper ops and liquidity calibration are completed.

## Components and integrated mechanics

| Contract | Role | Release invariant |
| --- | --- | --- |
| `XLiteToken` | xTOMB and xSHARE ERC-20s | xSHARE cap exactly **333,333**; one-way minter handoff; optional canonical-pool tax |
| `XTombLiteMasonry` | xTOMB/xSHARE LP staking | Six-hour independent deposit locks and claim cooldown; *no single-sided share staking* |
| `LiteV2TwapOracle` | V2 cumulative-price window + USD feed | 30-minute warmup, fresh + bounded spot deviation, minimum reserves, no spot-only minting |
| `LiteSellTaxController` | Sell-only dynamic Fire Tax | Quadratic rate, max **12%**, seven-hour recovery, conservative stale fallback, optional Genesis SQUARE 6% floor |
| `LiteLiquidityAdapter` | Verified V2 LP adds | Only adapter-held liquidity escapes tax, not arbitrary swap routers |
| `LiteLpFarm` | One pre-funded xSHARE farm per LP | One-year emissions; nonlinear withdraw fee max 3% below peg; stale fee oracle means **zero** withdrawal fee |
| `LiteLinearVesting` | Team/Developer/Treasury/Arbitrage grants | Separately funded 180-day streams, no revocation or admin sweep |
| `LiteChainlinkUsdSource` | Stablecoin/USD and native/USD | Heartbeat and Chainlink round validation, no manually set prices |
| `DeployOmnichainLite.s.sol` | Integrates all components | Creates three canonical V2 pairs, two LP Farms, vesting, tax/adapters, oracles and Masonry |

**Masonry:** Fresh validated xTOMB/USD TWAP must be **strictly greater than $1.01**; missing/stale observations fail closed. Epochs are six hours, max emission 2% of xTOMB supply, no catch-up, and no bootstrap below peg. Anyone can advance an eligible epoch by paying *$25 USD-equivalent* through a fresh verified stable/USD feed, or by native gas token through an optional native/USD feed. Exit Now returns half of an LP tranche, forfeits half to Treasury and all accrued pending xTOMB to Arbitrage. No bonds or debt are deployed.

**Pool topology:** xTOMB/xSHARE LP goes to Masonry. xTOMB/USDC and xSHARE/USDC LPs are separate Farms. The term USDC represents a deployment-verified USDC-equivalent token address; the Solidity code never embeds it.

**Tax:** Normal V2 sells directly into canonical tax pairs are taxed, including router-mediated token transfers to the pair. Deposits using the dedicated liquidity adapter are untaxed. This requires a **fee-on-transfer-aware V2 swap router method**. Arbitrary new pools can bypass V2 token transfer tax if only the canonical pair is recognized; cross-pool enforcement or gated routing remains a critical production requirement. For v4-enabled chains, use the existing `merge` branch's V4 hook family instead of assuming this V2 policy protects V4 pools.

## What is deliberately NOT represented as finished

- Real Uniswap V4 PoolManager or single shared multi-DEX hook.
- Zero-bypass tax on unofficial V2 pools; independent smart-contract security audit.
- Robust quote-market depth history through every intermediate tick/reserve state; the V2 TWAP checks endpoints and cannot prove every price move was an authenticated swap.
- Genesis seven-day reward vaults, NFT tiers, Fast Track escrow, keeper-driven compounding, Harvest All/Compound All, Treasury POL and buyback/Arbitrage execution.
- Independent review of the circulating-supply exclusion policy and actual reserve custody before production.
- Chain-specific production deployment verification, LP initialization, safe bridge assumption, audited approved xSHARE allocation, published live deployment receipts/addresses, audited frontend transaction simulations, external audits.

**Do not present this branch as a fully launched protocol or solicit public deposits.**

## Canonical release flow

`config/release.template.json` includes LONGYU's **reported** testnet factory/router, but keeps stablecoin, USD feed, beneficiary addresses, approved xSHARE allocation and liquidity floors NULL. The source MUST stay chain-agnostic. Copy it into a local release configuration and choose an actual chain, verified V2-compatible factory/router, non-depegged stable/quoted token, stable/USD price reference, reserve floors, token funding and an approved allocation.

The allocation validator conserves exactly 333,333 whole xSHARE tokens across:

- Two farm budgets, sale escrow, deployer;
- Four upfront distributions (Team, Developer, Treasury, Arbitrage);
- Four separately vested distributions (Team, Developer, Treasury, Arbitrage).

It does **not** silently scale the old 33,333-token breakdown to 333,333. Pending explicit approval, the template remains invalid.

```bash
cd lite
cp config/release.template.json config/release.json
# Complete and approve all address, source, peg supply and xSHARE allocation fields.
node --test config/release.test.mjs
node config/export.mjs config/release.json --validate-only
# Strict validation must pass before export.
node config/export.mjs config/release.json .env.local

# Review network read-only, without wallet transactions:
node scripts/preflight.mjs config/release.json

# Contract build/test, then simulated deployment:
forge build
forge test -vv
set -a; source .env.local; set +a
export RPC_URL="<verified-private-or-public-RPC>"
forge script script/DeployOmnichainLite.s.sol:DeployOmnichainLite \
  --rpc-url "$RPC_URL" --account "<local-encrypted-keystore>" -vvvv

# Only after review and successful full dry run:
forge script script/DeployOmnichainLite.s.sol:DeployOmnichainLite \
  --rpc-url "$RPC_URL" --account "<local-encrypted-keystore>" --broadcast --slow
```

Do **not** publish private RPC API keys or signers. Using an encrypted local Foundry keystore avoids embedding a plaintext private key in repository configs.

### Post-broadcast activation sequence

The deploy script does NOT seed pool liquidity, fabricate trading volume, or manually set oracle prices. After verified successful receipts:

1. Persist each actual deployed address and receipt in a chain-specific manifest, independently verify bytecode/ABI and tax exemptions.
2. Add verified xTOMB/stable price-discovery liquidity through `LiteLiquidityAdapter`, then add xSHARE/stable and xTOMB/xSHARE LPs, with one-trade caps.
3. Call the permissionless TWAP `poke` to anchor; observe genuine market activity and call again after at least 30 minutes. Ensure fresh USD feed, liquidity floors and spot-deviation guard all pass.
4. Validate normal/failing sells, every payout and native/USDC fee conversion, withdrawal below peg, abrupt liquidity withdrawals, and inactive-market behavior.
5. Open only after an external security review, keeper monitoring and tested emergency runbooks.

## Frontend integration

The existing React/Vite frontend now includes a **separate `/lite` route**, ABI bindings for the new xTOMB/xSHARE tokens, Masonry and both Farms, and wagmi registration for any network described by a **verified** Lite deployment manifest. The route exposes real LP approvals, deposits, claims, exits, Farm staking/withdrawals and permissionless stable-fee advancement. This integration does not replace existing V4 pages or their animated design.

The `lite/config/deployment.json` source currently has `status: "not-deployed"` and null contract addresses. Until signed transaction receipts, actual bytecode and source verification are reviewed and the manifest is marked `verified`, the Lite route displays a deployment-pending explanation and **no wallet write controls**. No dummy addresses or fabricated balances are injected.

Frontend build check: `cd frontend && pnpm install --frozen-lockfile && pnpm typecheck && pnpm build`.

## LONGYU-specific status

LONGYU Testnet chain ID `668801` and known public V2 factory/router are in the template, not in Solidity. The public sources do **not** verify suitable canonical USDC plus a production-grade USD/USD reference feed for this release. **The configuration is intentionally blocked** until these are verified or a separately audited replacement oracle is available.

This is an experimental chain. There is no known independent audit or guarantee of bridge security. Zero production capital is authorized.

Source network documentation: [LONGYU/LongyuL2](https://github.com/Longyu-L2/LongyuL2). Existing mature V4 Masonry integration remains on `merge`, whose [integration status](../docs/MASONRY_V4_IMPLEMENTATION_STATUS.md) describes its own remaining release gates.

## Circulating supply and expansion

The 2% ceiling uses `circulatingSupply()`: minted xTOMB supply minus current balances of a fixed, deployment-configured list of dedicated reserve accounts (1–32 distinct addresses). Set `launch.pegSupplyExclusions` in the release JSON; the exporter passes it as `PEG_SUPPLY_EXCLUSIONS`. Include the initial deployer inventory and Treasury reserve wallets, plus any actual xTOMB vesting/escrow or permanently inaccessible addresses as appropriate. Do not include user wallets, liquidity pools, adapters or the Masonry reward vault. Unminted allocations and already-burned supply are not subtracted. Only the token balance at each excluded address is deducted; released tokens automatically enter circulation. Keep reserve custody separate from public/user funds. The fixed list cannot be edited by governance; Treasury recipient rotation requires a prelisted reserve address. Review the full address list before deployment; arbitrary off-protocol pools or mixed-custody accounts cannot be identified automatically. The existing deployment must be redeployed if it uses the old constructor. Both stable and native fee paths recheck supply and the strict TWAP gate after payment, immediately before minting.
