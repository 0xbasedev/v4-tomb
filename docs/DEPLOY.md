# Deploy

How to deploy Old Money to a chain. Production deploys follow this exact path; testnet deploys differ only in that cbETH is mocked.

## Prerequisites

1. Working Foundry install (`forge --version`).
2. `forge install` has run (`lib/openzeppelin-contracts`, `lib/solady`, `lib/v4-core`, `lib/v4-periphery` populated).
3. All five pre-deploy gates from [SECURITY.md](SECURITY.md) are green for the build at HEAD.

## Required env vars

Set in `contracts/.env` (gitignored). Copy from `.env.example` and fill in.

| Var | Description |
|---|---|
| `DEPLOYER_PRIVATE_KEY` | Signer key for the deploy. Prefer `--ledger` over a raw PK; if using a PK use a fresh address with just enough gas. |
| `BASE_RPC_URL` / `BASE_SEPOLIA_RPC_URL` / `MAINNET_RPC_URL` / `ETH_SEPOLIA_RPC_URL` | RPC endpoint per chain. |
| `BASESCAN_API_KEY` | For `--verify`. |
| `GENESIS_POOL` | Address that receives 11,000 MONEY at genesis. **Until Sprint 13 lands the real `GenesisRewardPool` contract, set this to a temporary multisig or hot wallet that will hand the tokens over to the pool when it deploys.** |
| `MAIN_POOL` | Address that receives 140,000 MONEY. Same caveat as `GENESIS_POOL`. |
| `AIRDROP_WALLET` | Address that receives 9,000 MONEY for airdrop campaign. |
| `FARMING_POOL` | Address that receives 59,500 ESTATE. Same caveat — pending the `ShareRewardPool` contract in Sprint 13. |
| `COMMUNITY_FUND` | Address receiving the 5,500 ESTATE community vesting drip. |
| `DEV_FUND` | Address receiving the 5,000 ESTATE dev vesting drip. **Also controls `setTreasuryFund` / `setDevFund` rotation per Tomb's quirk — make this a multisig.** |
| `VESTING_START` (optional) | Unix timestamp for ESTATE vesting start. Defaults to `block.timestamp + 1 hour`. |
| `EPOCH_START` (optional) | Unix timestamp for first epoch. Defaults to `VESTING_START`. |

## Commands

```bash
# Base Sepolia (uses MockCbeth — no real cbETH on testnet)
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify

# Base mainnet (uses real cbETH at 0x2Ae3F1...)
forge script script/Deploy.s.sol --rpc-url base --broadcast --verify

# Dry run against a Base fork — no broadcast, just simulates
forge script script/Deploy.s.sol --rpc-url base
```

## What the script does

The script implements the same 6-step sequence validated in `test/integration/BaseForkHook.t.sol`:

1. Resolve cbETH (real on mainnet chains, MockCbeth on testnets).
2. Deploy `OldMoney`, `Estate`, `TrustNote`.
3. Mine a CREATE2 salt for `PegDefenseHook` → deploy via `create2` opcode at the required permission-bit address (`AFTER_INITIALIZE | BEFORE_SWAP` → low-14-bit pattern `0x1080`).
4. Call `PoolManager.initialize(poolKey, sqrtPriceX96)` on the live V4 PoolManager. The hook's `afterInitialize` fires and binds it to the pool.
5. Deploy `Oracle` pointing to the hook as `IPriceSource`.
6. Deploy `Treasury` + `Boardroom`, initialize both, run genesis distributions, hand off operator authority on every protocol contract to the Treasury.

The script asserts post-deploy that every operator handoff landed correctly and the hook is bound — it reverts the entire deploy if any check fails.

## Post-deploy steps (manual, NOT in the script)

1. **Deploy the Timelock** (`forge script script/DeployTimelock.s.sol` — TBD in Sprint 12c).
2. **Transfer ownership** of every contract from the deployer EOA to the Timelock:
   - `money.transferOwnership(timelock)` → `timelock.acceptOwnership()` (two-step)
   - Same for `estate`, `trustnote`, `treasury`, `boardroom`, `oracle`, `hook`
3. **Verify on BaseScan** — `--verify` should handle this automatically when the API key is set, but spot-check the contracts page for green checkmarks.
4. **Seed the V4 pool with initial liquidity.** The script initializes the pool but does NOT add liquidity. Someone (typically the team) must:
   - Acquire some cbETH (testnet: mint from MockCbeth; mainnet: buy on a DEX)
   - Acquire some MONEY (this is what the LP pools will distribute over time, so on day 1 the team supplies initial liquidity from the airdrop wallet allocation)
   - Use Uniswap's V4 position manager to add liquidity at a tight range around tick 0 (parity)

## Verifying the deploy

After running, check the output for the deployed addresses. Run the post-deploy verification script (TBD) to assert:

- Each contract's bytecode is non-empty at the deployed address.
- `treasury.operator()` returns the multisig that called the deploy.
- `money.operator()`, `estate.operator()`, `trustnote.operator()`, `boardroom.operator()` all return `treasury`.
- `hook.bound()` returns true and `hook.poolId()` matches `keccak256(abi.encode(poolKey))`.
- `oracle.priceSource()` returns the hook address.
- `treasury.isInitialized()` returns true.

## Known caveats / pending items

- **No real Genesis / Main / Share reward pool contracts yet.** Sprint 13 work. Until then, `GENESIS_POOL` / `MAIN_POOL` / `FARMING_POOL` are address placeholders that will later transfer their balances into the real pool contracts when those deploy.
- **No Timelock deploy script yet.** Sprint 12c.
- **No real liquidity provisioning.** Sprint 12c — a separate script to add initial liquidity to the V4 pool from the airdrop wallet allocation.
- **No automated pool-side swap test on mainnet.** The deploy script initializes the pool but doesn't run a swap through it. The first swap will trigger `beforeSwap` and the dynamic fee logic for real.

## Rollback / recovery

The Old Money deploy is mostly idempotent within a single chain: re-running the script on the same chain will hit the constructor `notInitialized` guard on `Treasury` and `Boardroom`. However, the V4 pool can only be initialized once per `PoolKey` — if the second deploy collides, `PoolManager.initialize` reverts.

If a deploy fails partway:
- The contracts already deployed remain on-chain forever (no `selfdestruct`).
- The deployer EOA still holds operator/owner on the partial contracts.
- Recover by either continuing the deploy with a custom one-off script, or accepting the wasted gas and starting fresh with new contract addresses.

For mainnet, do a dry-run against the fork first (`forge script ... --rpc-url base` without `--broadcast`) and confirm the simulation succeeds before broadcasting.
