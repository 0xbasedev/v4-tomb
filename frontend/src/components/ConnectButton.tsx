import { useEffect, useMemo, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";

import { Modal } from "@/components/Modal";

/**
 * Wallet control.
 *
 *   Connected → address chip (green dot on a manifest network, red otherwise);
 *               the chip disconnects.
 *   Otherwise → "Connect wallet" (one click with a single connector, an
 *               EIP-6963 picker when several are detected). Connecting asks
 *               for accounts only — never a transaction.
 */
export function ConnectButton({ compact = false }: { compact?: boolean }) {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, error, isPending, isError, reset, variables } = useConnect();
  const { disconnect } = useDisconnect();
  const { chains } = useSwitchChain();
  const [pickerOpen, setPickerOpen] = useState(false);

  const available = useMemo(() => {
    const hasEip6963 = connectors.some((c) => c.type === "injected" && c.id !== "injected");
    const filtered = hasEip6963
      ? connectors.filter((c) => c.id !== "injected")
      : connectors;
    const seen = new Set<string>();
    return filtered.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return true;
    });
  }, [connectors]);

  useEffect(() => {
    if (isConnected) setPickerOpen(false);
  }, [isConnected]);

  if (isConnected && address) {
    const known = chains.some((c) => c.id === chainId);
    return (
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => disconnect()}
          aria-label="Disconnect wallet"
          title="Disconnect"
          className="flex h-9 items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] pl-2.5 pr-3 font-mono text-[12px] text-bone-dim hover:border-white/20 hover:text-bone"
        >
          <span className={`h-2 w-2 rounded-full ${known ? "bg-ok" : "bg-bad"}`} />
          <span className="hidden sm:inline">{address.slice(0, 6)}…{address.slice(-4)}</span><span className="sm:hidden">Wallet</span>
        </button>
      </div>
    );
  }

  const singleMode = available.length <= 1;
  const errorMessage =
    (error as { shortMessage?: string } | null)?.shortMessage ||
    error?.message ||
    "Connection was rejected or failed. Check your wallet and try again.";

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => {
          reset();
          if (singleMode) {
            if (available[0]) connect({ connector: available[0] });
            return;
          }
          setPickerOpen(true);
        }}
        disabled={isPending || available.length === 0}
        className={`btn btn-primary ${compact ? "h-9 max-w-[80px] truncate px-2 text-[11px] sm:max-w-none sm:px-4 sm:text-[13px]" : "h-10 px-5"}`}
      >
        {available.length === 0 ? "No wallet found" : isPending && !pickerOpen ? "Confirm in wallet…" : "Connect wallet"}
      </button>
      {!pickerOpen && isError && <span className="sr-only" role="alert">Check your wallet and try again.</span>}
      {pickerOpen && available.length > 1 && (
        <Modal
          kicker="Wallet"
          title="Choose a wallet"
          width={420}
          onClose={() => {
            reset();
            setPickerOpen(false);
          }}
        >
          <p className="mb-4 text-[13px] leading-relaxed text-bone-dim">
            Select a detected browser wallet to connect. Connecting only shares your address and never sends a transaction.
          </p>
          <div className="space-y-2">
            {available.map((c) => {
              const label = c.id === "injected" ? "Browser Wallet" : (c.name?.trim() || c.id || "Browser Wallet");
              const pendingThis =
                isPending &&
                Boolean(variables?.connector && "uid" in variables.connector && variables.connector.uid === c.uid);
              const status = pendingThis ? "Confirm in wallet…" : "Detected";
              return (
                <button
                  key={c.uid}
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    reset();
                    connect(
                      { connector: c },
                      {
                        onSuccess: () => setPickerOpen(false),
                      },
                    );
                  }}
                  className="flex w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-3.5 py-3 text-left transition-colors hover:border-iris/45 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    {c.icon ? (
                      <img src={c.icon} alt="" className="h-7 w-7 shrink-0 rounded-lg object-contain" />
                    ) : (
                      <span
                        aria-hidden
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] font-mono text-[11px] text-bone-dim"
                      >
                        {label.slice(0, 2).toUpperCase()}
                      </span>
                    )}
                    <span className="truncate font-display text-[14px] font-semibold text-bone">{label}</span>
                  </span>
                  <span className={`shrink-0 font-mono text-[11px] ${pendingThis ? "text-iris-hot" : "text-ash"}`}>
                    {status}
                  </span>
                </button>
              );
            })}
          </div>
          {isError && (
            <p role="alert" className="mt-3 rounded-xl border border-bad/35 bg-bad/10 px-3 py-2 text-[12px] text-bad">
              {errorMessage}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
