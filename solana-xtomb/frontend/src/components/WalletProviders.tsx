"use client";
import { useEffect, useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import { clusterApiUrl } from "@solana/web3.js";
import { NETWORK } from "@/lib/config";
import "@solana/wallet-adapter-react-ui/styles.css";

export default function WalletProviders({ children }: { children: ReactNode }) {
  const endpoint = useMemo(
    () => (NETWORK === "devnet" ? clusterApiUrl("devnet") : clusterApiUrl("devnet")),
    []
  );
  const wallets = useMemo(
    () => [new PhantomWalletAdapter(), new SolflareWalletAdapter()],
    []
  );
  useEffect(() => {
    // Ambient drift is CSS-driven; GSAP route tweens live in RouteAnim.
  }, []);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
