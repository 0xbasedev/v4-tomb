import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

/**
 * Toast system — Art Deco transaction-status notifications. Used by the write
 * hooks to surface wallet prompts, pending confirmations, success, and reverts.
 *
 * Variants:
 *   "pending"  — gold rule, slow pulse animation, infinite duration
 *   "success"  — emerald, 6s auto-dismiss
 *   "error"    — ruby, 8s auto-dismiss
 *   "info"     — ivory, 4s auto-dismiss
 *
 * Toasts stack bottom-right. Each toast has a unique id so the dispatcher can
 * upgrade a pending toast to success/error in place rather than replacing.
 */

type ToastVariant = "pending" | "success" | "error" | "info";

export interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  message?: string;
  /** Optional explorer link for tx-hash visibility. */
  txHash?: string;
  /** Override auto-dismiss in ms. 0 = never auto-dismiss. */
  durationMs?: number;
}

interface ToastContextValue {
  toasts: Toast[];
  push: (t: Omit<Toast, "id"> & { id?: string }) => string;
  update: (id: string, patch: Partial<Omit<Toast, "id">>) => void;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATION: Record<ToastVariant, number> = {
  pending: 0,
  success: 6_000,
  error: 8_000,
  info: 4_000,
};

let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback((t: Omit<Toast, "id"> & { id?: string }) => {
    const id = t.id ?? `t-${++counter}`;
    setToasts((prev) => [...prev.filter((x) => x.id !== id), { ...t, id }]);
    return id;
  }, []);

  const update = useCallback((id: string, patch: Partial<Omit<Toast, "id">>) => {
    setToasts((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, push, update, dismiss }}>
      {children}
      <ToastViewport />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

/* ===== Viewport ===== */

function ToastViewport() {
  const ctx = useContext(ToastContext);
  if (!ctx) return null;
  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-50 flex w-[min(420px,calc(100vw-3rem))] flex-col gap-3">
      {ctx.toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const { dismiss } = useToast();
  const duration = toast.durationMs ?? DEFAULT_DURATION[toast.variant];

  useEffect(() => {
    if (duration <= 0) return;
    const id = window.setTimeout(() => dismiss(toast.id), duration);
    return () => window.clearTimeout(id);
  }, [duration, dismiss, toast.id]);

  const tone =
    toast.variant === "success"
      ? "border-deco-emerald/60 text-deco-emerald"
      : toast.variant === "error"
        ? "border-deco-ruby/60 text-deco-ruby"
        : toast.variant === "pending"
          ? "border-deco-gold/60 text-deco-gold animate-pulse"
          : "border-deco-ivory/40 text-deco-ivory";

  const explorerHref = toast.txHash
    ? `https://sepolia.basescan.org/tx/${toast.txHash}`
    : undefined;

  return (
    <div
      className={`pointer-events-auto bg-deco-ground deco-panel border ${tone}`}
      role="status"
    >
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div
            className="label-deco mb-1"
            style={{ color: "currentColor" }}
          >
            {toast.variant === "pending"
              ? "In Progress"
              : toast.variant === "success"
                ? "Confirmed"
                : toast.variant === "error"
                  ? "Reverted"
                  : "Notice"}
          </div>
          <div className="font-display text-base italic text-deco-ivory">
            {toast.title}
          </div>
          {toast.message && (
            <div className="mt-1 font-body text-sm italic text-deco-ivory-soft">
              {toast.message}
            </div>
          )}
          {explorerHref && (
            <a
              href={explorerHref}
              target="_blank"
              rel="noreferrer"
              className="label-deco mt-2 inline-block text-deco-gold transition-colors hover:text-deco-gold-light"
            >
              View on BaseScan →
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={() => dismiss(toast.id)}
          aria-label="Dismiss"
          className="font-ornament text-xl leading-none text-deco-gold-dark transition-colors hover:text-deco-gold"
        >
          ×
        </button>
      </div>
    </div>
  );
}
