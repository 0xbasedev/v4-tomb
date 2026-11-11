# Claude UI/UX handoff — xSHARE bridge ABI bundle

**Handoff updated:** 2026-11-04. **UI ownership:** Claude is actively developing the full protocol design and UI/UX. Do **not** replace that design or treat the repository's existing theme/component previews as the finished Claude implementation.

This handoff provides **source-derived JSON ABI interfaces**, checked against the named Solidity declarations and standard inherited OpenZeppelin signatures. They are immediately importable by Viem/Wagmi. **They are not presented as compiler-emitted, audited, or deployed artifacts.** Rebuild the pinned Solidity sources with Foundry and diff the emitted `out/<name>.sol/<name>.json.abi` before marking any release verified or enabling real-value routes.

## Files

| File | Contract and use |
| --- | --- |
| [`XTombShareBridge.json`](../frontend/src/lib/abis/XTombShareBridge.json) | Main bridge; quote/send, route limits, owner controls, send/receive events and inherited ownership getters |
| [`XTombBridgedShare.json`](../frontend/src/lib/abis/XTombBridgedShare.json) | Satellite token; standard 18-decimal ERC-20 reads/approval/transfer + bridge-only mint/burn methods |
| [`IHyperlaneMailbox.json`](../frontend/src/lib/abis/IHyperlaneMailbox.json) | Read `delivered(messageId)` at the destination Mailbox; also exposes the contract-facing quote/dispatch interface |

Source contracts are `contracts/src/bridge/XTombShareBridge.sol`, `XTombBridgedShare.sol` and `IHyperlaneMailbox.sol`. Their reviewed source blob SHAs for this handoff: `065d965c832ca92fd9b4d4f5c24bdec9d4636006`, `cea419855c20190936fa572d4b276506c2025d60`, `17d536c93ca474000f259fddb5064495014492d5`.

## Integration contract (important)

1. **Deployment data only:** Resolve each network from an approved, verified `xshare-bridge.release.json` (derived by Wizard and deployment pipeline), not the illustrative base `config/xshare-bridge.json`. The five built-in domains are Base 8453, Robinhood 4663, BSC 56, PulseChain 369, Sonic 146. Custom network bridging is **not** supported by the current bridge contract. All current template routes start disabled.
2. **Supported pairs:** Canonical xSHARE on one chosen home chain ↔ bridged xSHARE on a satellite. Satellite → satellite requires two distinct transactions via home. Never suggest the bridge directly swaps or zaps into destination LP.
3. **Route state:** Compare the source `routes(destination)` result (peer, `outboundEnabled`, limit) to the verified destination bridge; compare destination `routes(source)` peer; read destination `inboundPaused(source)` and `received(source, nonce)` for status. Confirm `asset()`, `isCanonical()`, `localDomain()`, `canonicalDomain()`, `mailbox()`, and `interchainSecurityModule()` match the deployment plan. Hide or disable send while any check is unverified.
4. **Wallet and allowances:** Read source `asset()` as the token address; 18 decimals. On **canonical** sends, ERC-20 `approve(bridge, amount)` is required if `allowance(owner, bridge) < amount`. On **satellite** sends, bridge invokes `bridgeBurn(sender, amount)` itself and no prior approve is needed. Never call `bridgeMint`/`bridgeBurn` directly from a wallet.
5. **Fee and send:** `quoteSend(uint32 destination, address recipient, uint256 amount) → uint256` returns required **native gas fee**; quote with the actual wallet account and refresh after any wallet/chain/amount/recipient change. Simulate `send(destination, recipient, amount)`, then submit with `value = quote` exactly. The fee is NOT an xSHARE buy/sell tax. Verify allowance, balances, gas and route bounds first.
6. **Pending messages:** Decode `TransferSent(bytes32 indexed messageId, uint32 indexed destination, address indexed sender, address recipient, uint256 amount, uint256 nonce, uint256 fee)` from a confirmed source transaction. Persist origin/destination domains, source hash, message ID, nonce, amount and recipient. Show **Pending delivery** until the **destination** `IHyperlaneMailbox.delivered(messageId)` returns true, then reconcile balance and optionally `TransferReceived`. Do not claim destination success solely from the source receipt. Never resubmit the original `send` to retry delivery.
7. **Owner-only controls:** `registerPeer(domain, peer, limit)`, `setOutboundEnabled(domain, enabled)` and `setInboundPaused(domain, paused)` are administrative; do not expose them as ordinary user controls. Do not enable routes until reciprocal peer and ISM verification, relayer liveness, canary round trips and finality checks.
8. **Sonic caution:** The repository's existing bridge runbook says publicly operated validator/relayer support was discontinued; a project-operated verified path is required. Leave the route disabled otherwise.

## Minimal Viem/Wagmi import example

```ts
import bridgeAbi from "../lib/abis/XTombShareBridge.json";
import shareAbi from "../lib/abis/XTombBridgedShare.json";
import mailboxAbi from "../lib/abis/IHyperlaneMailbox.json";

// Use bridgeAbi for readContract({functionName:"routes"|"quoteSend"...})
// Use bridgeAbi for writeContract({functionName:"send", value:quotedNativeFee...})
// Use shareAbi for balanceOf/allowance/approve if source asset is a bridged share.
// Use mailboxAbi for destination delivered(messageId) confirmation.
```

The example imports are illustrative; adjust relative paths to Claude's actual UI modules. `XTombShareBridge.json` includes the inherited ownership methods, explicitly indexed bridge events, and source-declared custom errors for front-end decoding.

## Release validation — not yet executed in this handoff

```sh
node scripts/install-contract-deps.mjs
cd contracts
forge build
forge inspect XTombShareBridge abi
forge inspect XTombBridgedShare abi
forge inspect IHyperlaneMailbox abi
forge test --match-contract XTombShareBridgeTest
XSHARE_BRIDGE_FORKS=true forge test --match-contract XTombShareBridgeForkTest
```

Compare each emitted ABI against the committed JSON before the app uses it for a funded deployment. Independent Solidity security review, Hyperlane ISM/relayer checks, chain-specific receipts and deployed runtime code checks are required separately.

**Status:** Source ABIs supplied to Claude; ongoing UI implementation and live contract bindings are **not** claimed complete. These files should be handed to Claude's active UI branch/workspace; no assumption is made that Claude has automatically imported them.
