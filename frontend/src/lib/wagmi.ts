import { http, createConfig } from "wagmi";
import { defineChain, type Chain } from "viem";
import { injected } from "wagmi/connectors/injected";
import { networks } from "./networks";

const toChain = (network: (typeof networks)[number]) => defineChain({
  id: network.id,
  name: network.name,
  nativeCurrency: network.nativeCurrency,
  rpcUrls: { default: { http: [network.rpcUrl] } },
  blockExplorers: network.explorerUrl
    ? { default: { name: "Explorer", url: network.explorerUrl } }
    : undefined,
  testnet: network.testnet,
});
const chains: [Chain, ...Chain[]] = [toChain(networks[0]), ...networks.slice(1).map(toChain)];

export const wagmiConfig = createConfig({
  chains,
  // Do not assume a Multicall3 deployment exists on an arbitrary EVM chain.
  transports: Object.fromEntries(networks.map((network) => [network.id, http(network.rpcUrl)])),
  connectors: [injected()],
});
