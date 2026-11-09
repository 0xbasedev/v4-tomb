import { bridgeNetwork } from "@/lib/create3";
import { defineChain } from "viem";
import { http, createConfig, type Transport } from "wagmi";
import { bsc, type Chain } from "wagmi/chains";
import { injected } from "wagmi/connectors";

import { DEPLOYMENTS, REGISTRY } from "@/lib/launch";

/**
 * Wallet chains (Jess, 2026-11-09): the app lists exactly three networks —
 * Solana, BSC, and Robinhood. Solana is not an EVM chain and is served by the
 * Solana side of the app; this config carries the two EVM networks. No
 * "coming soon" chains: a network appears here when it is a real launch
 * target, not because a PoolManager happens to exist there. RPCs default to
 * public endpoints and can be overridden per chain with VITE_RPC_<chainId>.
 */
export const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Robinhood Explorer", url: "https://robin.etherscan.io" } },
});

const KNOWN: Chain[] = [robinhood, bsc];
const chains = KNOWN as [Chain, ...Chain[]];

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
  id === undefined ? "—" : (REGISTRY.chains.find((c) => c.id === id)?.name ?? bridgeNetwork(id)?.name ?? KNOWN.find((c) => c.id === id)?.name ?? `Chain ${id}`);
