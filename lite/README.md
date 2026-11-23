# xTomb Lite: LONGYU testnet pilot

**Status: NOT DEPLOYED. UNSAFE DEMONSTRATION. DO NOT ACCEPT PUBLIC FUNDS.**

This is a standalone, narrowly scoped Solidity pilot, deliberately separate from the production Masonry/v4 branch. It uses LONGYU's documented Uniswap-V2-style factory to create an **xTOMB/xSHARE LP** and lets that LP stake in a tiny Masonry. The existing `merge` branch is not yet ready for a real launch, and LONGYU has **no verified Uniswap V4 PoolManager** in the project's documentation.

## Implemented, not implemented

Implemented in this testnet pilot:

- Testnet-only deployment; contract constructor rejects every chain except **668801**.
- xTOMB and xSHARE test ERC-20s. xSHARE immutable hard cap **333,333 tokens**; any test mint amounts come from explicit environment variables. No unapproved allocation plan.
- **LP-only** Masonry staking with independent six-hour lock on each deposit tranche; no single-sided xSHARE.
- Six-hour epochs, no catch-up, fresh observed price **strictly > $1.01** to mint, maximum 2% xTOMB supply expansion per eligible epoch, zero bootstrap exception.
- Permissionless advance, charging **25 mock six-decimal dollars** to the configured Treasury in the pilot. Optional BNB payment is coded but disabled without a separate validated native/USD oracle.
- Six-hour claim cooldown; Exit Now returns half the LP to the user, sends half to Treasury, and forfeits all pending xTOMB to Arbitrage.
- **No bonds or debt**, period.

**Not implemented:** a real TWAP oracle (manual price simulator only), a verified stablecoin, actual $25 USDC collection, Uniswap V4 hooks, Fire Tax/recovery, launch allocations, official xTOMB/USDC and xSHARE/USDC Farms, Genesis, NFT passes, vesting, treasury defense, route guards, LP seeding, verified frontend wiring, owner permissions beyond the pilot and external audit. Do not use this code in production or deploy it as an official xTomb protocol. This is a testnet-only first-step experiment, not a release candidate.

## Source-backed network settings

| Field | LONGYU Testnet |
| --- | --- |
| Chain ID | `668801` (`0xa3481`) |
| RPC | `https://rpc-testnet.longyu.network` |
| Explorer | `https://scan-testnet.longyu.network` |
| Gas | tBNB, bridged from BSC testnet |
| V2 factory | `0xfE5372cA129113bf12EC70D1EE4A7cBB14f172B0` |
| V2 router | `0xed3Eb7fe322424C14cc356Ab182021cAb8dCf01A` |
| Bridge | `https://testnet.longyu.network/bridge.html` |
| V4 PoolManager | **Unverified / absent from LONGYU docs** |
| Verified USDC / TWAP | **Not established** |

Source: [LONGYU project repository README](https://github.com/Longyu-L2/LongyuL2).

## Local checks

Foundry (Forge + Cast) is required. From the repository root:

```bash
cd lite
forge fmt --check
forge build
forge test -vv
```

Tests cover the mint gate at and below 1.01, stale source failure, 2% emission ceiling, no catch-up, LP exit penalty and loss of rewards, share supply cap, and mint authorization handoff. The test LP is an ERC-20 mock; tests do **not** certify the actual DEX or its bridge.

## Funding & signer

Fund a **disposable testnet deployer** with tBNB through the LONGYU testnet bridge. Use an encrypted local Foundry keystore; never paste a private key into ChatGPT, GitHub, a committed config file or a CI log.

```bash
cast wallet import xtomb-lite --interactive
cd lite
cp .env.example .env
# Edit .env with public addresses, a FUTURE UNIX genesis timestamp, and TEST-ONLY seed amounts.
# The keystore address must match DEPLOYER_ADDRESS.
set -a
source .env
set +a
```

Example **testnet-only** seed values (these are NOT approved tokenomics or distributions):

```ini
TEST_XTOMB_SEED_WEI=1000000000000000000000
TEST_XSHARE_SEED_WEI=1000000000000000000000
TEST_USD_SEED_UNITS=1000000000
```

Set distinct, explicitly reviewed `TREASURY_ADDRESS` and `ARBITRAGE_ADDRESS`. The code does not silently supply a default or receive privileged funds at a developer wallet.

## Preflight

From an internet-enabled workstation, query the network rather than trusting the registry alone:

```bash
curl -s https://rpc-testnet.longyu.network \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# Require result 0xa3481
```

Confirm the factory has deployed bytecode via `eth_getCode`. Run Foundry build/tests, review seed values, and dry-run **without** `--broadcast` first. Testnet tBNB is needed for the real broadcast.

```bash
forge script script/DeployLongyuLite.s.sol:DeployXTombLiteLongyu \
  --rpc-url https://rpc-testnet.longyu.network --account xtomb-lite -vvvv

# ONLY after successful simulation and explicit local signing:
forge script script/DeployLongyuLite.s.sol:DeployXTombLiteLongyu \
  --rpc-url https://rpc-testnet.longyu.network --account xtomb-lite \
  --broadcast --slow
```

The script deploys two **test tokens**, a clearly labeled MockUSD, a mock price source initialized to **zero**, creates the xTOMB/xSHARE pair through the selected factory, deploys the Lite Masonry, and permanently hands the xTOMB minter to Masonry. **It does not seed the LP**, configure a real oracle, open Genesis, or collect genuine dollars. A zero price prevents expansion by default.

After a successful broadcast, record transaction receipts and the **actual** token, mockUSD, pair, oracle and Masonry addresses in a chain-specific manifest. Minted pilot tokens must be supplied to the V2 router manually to seed a test LP. A demo price may then be set deliberately on the *unsafe* manual oracle, but never present it as a genuine TWAP.

## Production blockers

A genuine xTomb Lite launch requires validated xTOMB/stable LP reference market and oracle, verified chain infrastructure, fully approved 333,333 xSHARE allocation mapping, Fire Tax capped at 12% with seven-hour recovery, formal deployment wiring of the two Farm LP pools and Masonry LP, real stablecoin, adversarial testing, governance approvals, and independent security review. Replacing the manually set price with a real fresh guarded oracle is non-negotiable.

**Mainnet chain 668800 is intentionally rejected by this pilot even if an operator supplies its RPC.**
