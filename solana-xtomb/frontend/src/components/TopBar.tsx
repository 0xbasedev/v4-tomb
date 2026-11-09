"use client";
import Link from "next/link";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { NETWORK, PROGRAM_ID } from "@/lib/config";

export default function TopBar() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-crypt/90 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 px-4 py-3">
        <Link href="/" className="font-display text-lg font-black tracking-wide text-bone">
          x<span className="text-ember">TOMB</span>
          <span className="ml-2 hidden font-mono text-[10px] font-normal tracking-widest text-dust sm:inline">
            SOLANA · {NETWORK.toUpperCase()}
          </span>
        </Link>
        <div className="flex items-center gap-2">
          <span className="hidden font-mono text-[10px] text-dust md:inline" title={PROGRAM_ID}>
            {PROGRAM_ID.slice(0, 4)}…{PROGRAM_ID.slice(-4)}
          </span>
          <WalletMultiButton className="!h-9 !bg-ember !font-display !text-xs" />
        </div>
      </div>
    </header>
  );
}
