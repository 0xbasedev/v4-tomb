import { http, createConfig, type Transport } from "wagmi";
import {
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

import { DEPLOYMENTS, REGISTRY } from "@/lib/launch";

/**
 * Wallet chains = every chain in config/official-infrastructure.json (a
 * Uniswap v4 PoolManager plus native USDC), so a wallet can connect and
 * switch anywhere xTOMB could launch. Reads only ever go to chains with a
 * verified deployment; RPCs default to public endpoints and can be overridden
 * per chain with VITE_RPC_<chainId>.
 */
const KNOWN: Chain[] = [
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

const listed = new Set(REGISTRY.chains.map((c) => c.id));
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
  id === undefined ? "—" : (REGISTRY.chains.find((c) => c.id === id)?.name ?? KNOWN.find((c) => c.id === id)?.name ?? `Chain ${id}`);
