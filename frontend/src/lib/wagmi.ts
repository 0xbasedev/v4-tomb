import { defineChain, type Chain } from "viem";
import { http, createConfig, type Transport } from "wagmi";
import { injected } from "wagmi/connectors";

import { networks } from "./networks";

const env = import.meta.env as unknown as Record<string, string | undefined>;
const rpcFor = (network: (typeof networks)[number]) => env[`VITE_RPC_${network.id}`] ?? network.rpcUrl;

const toChain = (network: (typeof networks)[number]) =>
  defineChain({
    id: network.id,
    name: network.name,
    nativeCurrency: network.nativeCurrency,
    rpcUrls: { default: { http: [rpcFor(network)] } },
    blockExplorers: network.explorerUrl ? { default: { name: "Explorer", url: network.explorerUrl } } : undefined,
    testnet: network.testnet,
  });

const chains = networks.map(toChain) as unknown as [Chain, ...Chain[]];

/**
 * Wallet chains are exactly the manifest's networks. Multicall3 is not assumed
 * to exist on an arbitrary chain, so batched reads fall back to plain calls.
 */
export const wagmiConfig = createConfig({
  chains,
  transports: Object.fromEntries(networks.map((network) => [network.id, http(rpcFor(network))])) as Record<number, Transport>,
  connectors: [injected()],
  multiInjectedProviderDiscovery: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
