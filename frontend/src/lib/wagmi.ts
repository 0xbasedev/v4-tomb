import { http, createConfig } from "wagmi";
import { base, baseSepolia } from "wagmi/chains";
import { injected } from "wagmi/connectors";

/**
 * Wagmi config for Old Money frontend. Supports Base mainnet (production) and Base
 * Sepolia (testnet). RPC URLs default to the public endpoints — override via env
 * (VITE_BASE_RPC_URL, VITE_BASE_SEPOLIA_RPC_URL) if you need higher rate limits.
 */
export const wagmiConfig = createConfig({
  chains: [base, baseSepolia],
  transports: {
    [base.id]: http(
      import.meta.env.VITE_BASE_RPC_URL ?? "https://mainnet.base.org",
    ),
    [baseSepolia.id]: http(
      import.meta.env.VITE_BASE_SEPOLIA_RPC_URL ?? "https://sepolia.base.org",
    ),
  },
  connectors: [injected()],
});
