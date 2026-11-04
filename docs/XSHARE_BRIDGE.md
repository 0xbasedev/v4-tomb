# xSHARE Bridge

The xSHARE bridge moves original xSHARE between the Wizard-selected home chain and Base, Robinhood Chain, BNB Smart Chain, PulseChain, or Sonic. The other four chains receive a separately identified 18-decimal token named Bridged xSHARE with symbol xSHARE. A satellite-to-satellite transfer takes two independent transfers through the home chain. The bridge supports xSHARE only.

| Network | Chain ID and Hyperlane domain | Native fee currency |
| --- | ---: | --- |
| Base | 8453 | ETH |
| Robinhood Chain | 4663 | ETH |
| BNB Smart Chain | 56 | BNB |
| PulseChain | 369 | PLS |
| Sonic | 146 | S |

The manifest starts with five disabled networks and blank project addresses. The Mailboxes in it are infrastructure addresses. Configure the final home chain from the Wizard and populate each chain's bridge, token, and approved message verifier after deployment. Bridge support does not certify a chain for the separate Masonry protocol launch.

## UI integration for Claude

1. Use `xshare-bridge.json` to render the five network options in the theme. In preview, grey out all five and show “Bridge unavailable”. For Sonic, the detail can say “Awaiting relayer and verifier setup”. Remove any old OFT or ONFT copy tied to this bridge.
2. When an approved deployment is published, resolve the source and destination by chain ID. Require both deployment records, the current wallet network, a supported home-to-satellite direction, and verified reciprocal peers and limits. Read `routes(domain)` on both ends. Require source `outboundEnabled` and destination `inboundPaused(sourceDomain) == false` before enabling Send. Invalidate quote, allowance, and simulation when wallet, chain, amount, recipient, or route changes.
3. Read `asset()` and the ERC-20 balance on the source chain. Amounts use 18 decimals. For a home-chain send, approve the bridge for the amount if the allowance is insufficient. For a satellite send, the bridge burns the connected sender's tokens directly as part of the signed send.
4. Call `quoteSend(destinationDomain, recipient, amount)` as the sending wallet. Display the quote in the source chain's native currency and estimate source transaction gas separately. Simulate and call `send(destinationDomain, recipient, amount)` with that exact quote as `value`. If the fee changes, refresh the quote and simulate again. Confirm the recipient and destination before signing. The recipient must be able to use the address on that chain.
5. Parse `TransferSent` from the confirmed source receipt. Store its `messageId`, source chain, source hash, and destination chain. Display “Awaiting delivery” until `delivered(messageId)` on the destination Mailbox returns true. Keep the pending record across reloads. A failed destination attempt can be retried by the relayer with the same message. Resubmitting the source transaction creates another transfer.
6. After delivery, refresh the destination token balance and optionally link to the transaction or the [Hyperlane Explorer](https://explorer.hyperlane.xyz/). Use the deployment manifest to distinguish canonical and bridged assets, since they share the symbol xSHARE.

The ABI bundle contains `XTombShareBridge.json`, `XTombBridgedShare.json`, and `IHyperlaneMailbox.json`. The wrapped token ABI includes the standard ERC-20 reads and transfers. Use the original xSHARE token ABI from the canonical deployment if it exposes additional behavior.

## Deploy and verify

- Set the Wizard-selected `canonicalDomain` in a release copy of the manifest and enter the approved per-chain `bridgeIsm` addresses. An ISM is Hyperlane's message verifier. The checked-in observed default ISMs are for reference. Confirm the verifier's source domains, signer threshold, independent operators, checkpoint availability, and finality settings. [Hyperlane modular security](https://docs.hyperlane.xyz/docs/protocol/ISM/modular-security)
- Confirm the original token address and policy on the home chain. The home bridge expects an existing standard 18-decimal ERC-20 that transfers the exact amount. Deploy one bridge per chain. Pass the canonical token address on the home chain and the zero address on each satellite. Use the designated governance owner on each chain.
- From `contracts/`, simulate the deploy script against each intended RPC. The positional network index is the entry's index in the release manifest. The script checks the chain and confirms that the Mailbox resolves the selected verifier for the deployed bridge.

  ```sh
  XSHARE_BRIDGE_CONFIG=../config/xshare-bridge.release.json \
    forge script script/DeployXTombShareBridge.s.sol:DeployXTombShareBridge \
    --rpc-url "$CHAIN_RPC_URL" --account "$DEPLOYER_ACCOUNT" \
    --sig 'run(uint256,address,address)' "$NETWORK_INDEX" "$BRIDGE_OWNER" "$TOKEN_ARGUMENT"
  ```

- After a reviewed deployment, verify code, owner, home domain, token, Mailbox, and verifier on each chain. Register reciprocal peer addresses with the same approved cap in token base units. The peer, cap, home domain, and verifier address are permanent in each bridge instance. Read back both sides before activating either direction. Review how the chosen ISM can be maintained or migrated if its validator set changes.
- Run a small two-way canary with production validators and relayer coverage before publishing a route as enabled. Confirm source fee collection, destination delivery, token balances, and escrow recovery. Sonic's public Abacus Works validators and relayer were wound down on August 10, 2026. A Sonic Mailbox and fee quote still respond. Provide a verified Sonic validator and relayer path, such as a project-operated Hyperlane setup, and repeat the same canary before enabling Sonic. [Hyperlane deprecation schedule](https://docs.hyperlane.xyz/docs/reference/deprecated-chains) · [Hyperlane relayer](https://docs.hyperlane.xyz/docs/protocol/agents/relayer) · [Hyperlane validator](https://docs.hyperlane.xyz/docs/protocol/agents/validators)
- For a deposit-only halt, disable outbound on the home chain for the affected route and preserve the return path. During a verifier incident, governance can pause inbound settlement and disable new sends on both sides. In-flight transfers remain pending while settlement is paused. Governance should monitor escrow, pending messages, and the age of undelivered transfers. There is no administrator mint, escrow withdrawal, or independent source refund.

## Verification

```sh
cd contracts
forge test --match-contract XTombShareBridgeTest
XSHARE_BRIDGE_FORKS=true forge test --match-contract XTombShareBridgeForkTest
```

The unit suite uses mock Mailboxes to exercise all five possible home-chain selections. The opt-in fork test runs four two-way routes through the deployed Hyperlane Mailboxes and fee hooks across all five chains, using a test verifier to exercise both rejection and delivery. The fork test sends no live messages and provides no evidence about production validator or relayer liveness.

The bridge compiles with Solidity 0.8.26 and the Shanghai EVM target because PulseChain rejects Cancun opcodes used by the compiler. The other Masonry and Uniswap V4 contracts retain their Cancun target.
