# Deployed contracts

Per-chain deploy records. Update this every time `Deploy.s.sol` runs successfully on a new chain.

The authoritative source is always the broadcast file at `contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json` — this doc is the human-readable summary.

---

## Base Sepolia (chainId 84532)

**First deploy:** 2026-05-22 (block `41856194`, tx `0xa95161a9...`)

**Deployer EOA:** `0x6d606cc634F20f5534fba072757F2c2C7B835Bb9`

**Deploy cost:** 21,166,414 gas total · 0.000127 ETH at 0.006 gwei avg

### Contracts

| Contract | Address | BaseScan |
|---|---|---|
| cbETH (mock) | `0x3418087d89208f691AEeF716a403102D844ff7E6` | [view](https://sepolia.basescan.org/address/0x3418087d89208f691AEeF716a403102D844ff7E6) |
| $MONEY (`OldMoney`) | `0x254809Af54b89F28983e6EA7117bEFA22669C84F` | [view](https://sepolia.basescan.org/address/0x254809Af54b89F28983e6EA7117bEFA22669C84F) |
| $ESTATE (`Estate`) | `0x4018Db28b68Bb49386D92a70DA8a16633730F759` | [view](https://sepolia.basescan.org/address/0x4018Db28b68Bb49386D92a70DA8a16633730F759) |
| $TRUSTNOTE (`TrustNote`) | `0x3F0e69FAC1822AdD76ae6529d4b501b9De745D94` | [view](https://sepolia.basescan.org/address/0x3F0e69FAC1822AdD76ae6529d4b501b9De745D94) |
| `PegDefenseHook` | `0xF0DBfD05d9Aab625e489e49F97f16c9fA9Ee9080` | [view](https://sepolia.basescan.org/address/0xF0DBfD05d9Aab625e489e49F97f16c9fA9Ee9080) |
| `Oracle` | `0xcacF0Cd984491679c8F10cBc8cE1A57657Fd1A74` | [view](https://sepolia.basescan.org/address/0xcacF0Cd984491679c8F10cBc8cE1A57657Fd1A74) |
| `GenesisRewardPool` | `0x72cE03cCA932E6C4B5380693d0f914e52dc574C8` | [view](https://sepolia.basescan.org/address/0x72cE03cCA932E6C4B5380693d0f914e52dc574C8) |
| `MainRewardPool` | `0x58b149740d2Bb6dc47CC03AEDA088435bDAb9256` | [view](https://sepolia.basescan.org/address/0x58b149740d2Bb6dc47CC03AEDA088435bDAb9256) |
| `ShareRewardPool` | `0xA0CA315073C65A97692b57343d0EB1f3889F989e` | [view](https://sepolia.basescan.org/address/0xA0CA315073C65A97692b57343d0EB1f3889F989e) |
| `Treasury` | `0x522b65A06EEdf277B5784eC18167963157C9cC06` | [view](https://sepolia.basescan.org/address/0x522b65A06EEdf277B5784eC18167963157C9cC06) |
| `Boardroom` | `0xE9648a87450e933c76Cfc19415F03c3EF65af373` | [view](https://sepolia.basescan.org/address/0xE9648a87450e933c76Cfc19415F03c3EF65af373) |

### V4 pool

| Field | Value |
|---|---|
| Pool currencies | `cbETH` mock `0x3418...` + `MONEY` `0x2548...` |
| V4 PoolManager | `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408` (Base Sepolia canonical) |
| Hook | `PegDefenseHook` `0xF0DB...9080` (low 14 bits = `0x1080` = `AFTER_INITIALIZE` + `BEFORE_SWAP` ✓) |
| Fee | `LPFeeLibrary.DYNAMIC_FEE_FLAG` |
| Tick spacing | 60 |
| Initial price | `TickMath.getSqrtPriceAtTick(0)` (1 MONEY = 1 cbETH parity) |

### Verified ✅ on BaseScan

All 11 contracts verified during the deploy via `--verify`. Compile profile: solc 0.8.26, cancun EVM, 1,000,000 optimizer runs.

### Initial token balances

| Address | $MONEY | $ESTATE |
|---|---|---|
| GenesisRewardPool | 11,000 | — |
| MainRewardPool | 140,000 | — |
| ShareRewardPool | — | 59,500 |
| Airdrop wallet (`0x6d60...5Bb9`) | 9,001 ¹ | — |
| Deployer (`0x6d60...5Bb9`) | (same as airdrop wallet in testnet) | 1 ² |

¹ 9,000 from `distributeReward` + 1 from `OldMoney` constructor seed (the airdrop wallet doubles as the deployer in this testnet deploy).
² 1 ESTATE from `Estate` constructor seed (deployer keeps for initial LP setup).

### Operator wiring (post-deploy)

| Contract | Operator/Trustees |
|---|---|
| $MONEY | `Treasury` `0x522b...cC06` ✓ |
| $ESTATE | `Treasury` `0x522b...cC06` ✓ |
| $TRUSTNOTE | `Treasury` `0x522b...cC06` ✓ |
| `Boardroom` | `Treasury` `0x522b...cC06` ✓ |
| `Treasury` | Deployer `0x6d60...5Bb9` (rotate to Timelock in Sprint 14) |
| `PegDefenseHook` | Deployer `0x6d60...5Bb9` (also a Trustees field, rotate to Timelock) |
| `Oracle` | Deployer `0x6d60...5Bb9` (rotate to Timelock) |
| `GenesisRewardPool` / `MainRewardPool` / `ShareRewardPool` | Deployer `0x6d60...5Bb9` (operator-only — adds LP pool entries) |

### Pending manual steps before testnet is "alive"

1. **Add LP pool entries** to the three reward pools. The deployer calls `add(allocPoint, lpToken, false, 0)` on each pool for every LP token the protocol supports. Example sequence:
   ```
   genesisRewardPool.add(100, MONEY_CBETH_LP_TOKEN, false, 0);
   mainRewardPool.add(100, MONEY_CBETH_LP_TOKEN, false, 0);
   shareRewardPool.add(100, ESTATE_CBETH_LP_TOKEN, false, 0);
   ```
   On Base Sepolia, "LP tokens" come from the V4 PositionManager — adding liquidity to a V4 pool gives you an ERC-721 position NFT, NOT an ERC-20 LP token. To use MasterChef-style staking, we'll need wrapper contracts that ERC-20-ize the V4 positions. **This is a real gap to fix before Sprint 17 (frontend).**
2. **Seed initial liquidity** into the MONEY/cbETH V4 pool (manual call to `PositionManager.modifyLiquidities`).
3. **Rotate ownership** of every contract to the Timelock (Sprint 14).

---

## Base mainnet (chainId 8453) — NOT YET DEPLOYED

When ready, deploy with:

```bash
forge script script/Deploy.s.sol --rpc-url base --broadcast --verify
```

Pre-mainnet checklist:
- [ ] All 5 pre-deploy gates green ([SECURITY.md](SECURITY.md))
- [ ] Real multisigs set for AIRDROP_WALLET / COMMUNITY_FUND / DEV_FUND
- [ ] LP wrapper contracts deployed (the V4-position-to-ERC20 piece)
- [ ] Initial liquidity sourced (~$10k-$100k of cbETH + MONEY for the V4 pool)
- [ ] Genesis pool open time scheduled and communicated
- [ ] Professional audit complete

---

## Ethereum Sepolia (chainId 11155111) — NOT YET DEPLOYED

(Base Sepolia is the primary testnet — only deploy to ETH Sepolia if specifically needed.)
