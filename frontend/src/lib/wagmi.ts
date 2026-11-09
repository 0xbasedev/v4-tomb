import { bridgeNetwork } from "@/lib/create3";
import { http, createConfig, type Transport } from "wagmi";
import {
  bsc, pulsechain, sonic,
  arbitrum,
  arbitrumSepolia,
  avalanche,
  base,
  baseSepolia,
  celo,
  hyperEvm,
  ink,
  mainnet,
  monad,
  optimism,
  polygon,
  sepolia,
  unichain,
  unichainSepolia,
  worldchain,
  xLayer,
  type Chain,
} from "wagmi/chains";
import { injected } from "wagmi/connectors";

import networkConfig from "@config/frontend-networks.json";
import { defineChain } from "viem";
import { DEPLOYMENTS, REGISTRY } from "@/lib/launch";

/**
 * Wallet chains follow config/frontend-networks.json, including inactive expansion
 * destinations. Infrastructure availability is not protocol launch availability. Reads only ever go to chains with a
 * verified deployment; RPCs default to public endpoints and can be overridden
 * per chain with VITE_RPC_<chainId>.
 */
const primary = networkConfig.networks.find((n) => n.id === networkConfig.primaryChainId)!;
export const robinhood = defineChain({ id: primary.id, name: primary.name, nativeCurrency: primary.nativeCurrency!, rpcUrls: { default: { http: [primary.rpcUrl!] } }, blockExplorers: { default: { name: "Blockscout", url: primary.explorerUrl! } } });
const KNOWN: Chain[] = [
  robinhood, bsc, pulsechain, sonic,
  base,
  arbitrum,
  optimism,
  unichain,
  polygon,
  avalanche,
  worldchain,
  ink,
  xLayer,
  celo,
  monad,
  hyperEvm,
  mainnet,
  baseSepolia,
  arbitrumSepolia,
  unichainSepolia,
  sepolia,
];

const listed = new Set(networkConfig.networks.map((c) => c.id));
const chains = KNOWN.filter((c) => listed.has(c.id)) as [Chain, ...Chain[]];

const env = import.meta.env as Record<string, string | undefined>;
const transports = Object.fromEntries(chains.map((c) => [c.id, http(env[`VITE_RPC_${c.id}`])])) as Record<number, Transport>;

export const wagmiConfig = createConfig({
  chains,
  transports,
  connectors: [injected()],
});

export const SUPPORTED_CHAIN_IDS = chains.map((c) => c.id);
export const DEPLOYED_CHAIN_IDS = DEPLOYMENTS.map((d) => d.chainId);
export const chainName = (id: number | undefined) =>
  id === undefined ? "—" : (networkConfig.networks.find((c) => c.id === id)?.name ?? REGISTRY.chains.find((c) => c.id === id)?.name ?? bridgeNetwork(id)?.name ?? KNOWN.find((c) => c.id === id)?.name ?? `Chain ${id}`);
