import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { EASE, gsap, prefersReducedMotion } from "@/lib/motion";

/**
 * Toasts — transaction lifecycle notifications.
 *
 *   pending  ember spinner, sticky
 *   success  green, 6s, with a draining progress line
 *   error    red, 8s
 *   info     neutral, 4s
 *
 * Toasts slide in from the right with GSAP and upgrade in place (pending →
 * success) so a transaction is one card from signature to confirmation.
 */

type ToastVariant = "pending" | "success" | "error" | "info";

export interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  message?: string;
  txHash?: string;
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

function ToastViewport() {
  const ctx = useContext(ToastContext);
  if (!ctx) return null;
  return (
    <div className="pointer-events-none fixed bottom-24 right-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2 md:bottom-6 md:right-6">
      {ctx.toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}

const TONE: Record<ToastVariant, { dot: string; label: string; bar: string }> = {
  pending: { dot: "bg-ember", label: "In progress", bar: "bg-ember" },
  success: { dot: "bg-ok", label: "Confirmed", bar: "bg-ok" },
  error: { dot: "bg-bad", label: "Failed", bar: "bg-bad" },
  info: { dot: "bg-bone-dim", label: "Notice", bar: "bg-bone-dim" },
};

function ToastCard({ toast }: { toast: Toast }) {
  const { dismiss } = useToast();
  const el = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const duration = toast.durationMs ?? DEFAULT_DURATION[toast.variant];
  const tone = TONE[toast.variant];

  useEffect(() => {
    if (!el.current || prefersReducedMotion()) return;
    gsap.fromTo(el.current, { x: 40, autoAlpha: 0, scale: 0.98 }, { x: 0, autoAlpha: 1, scale: 1, duration: 0.5, ease: EASE.snap });
  }, []);

  useEffect(() => {
    if (duration <= 0) return;
    let tween: gsap.core.Tween | undefined;
    if (bar.current) tween = gsap.fromTo(bar.current, { scaleX: 1 }, { scaleX: 0, duration: duration / 1000, ease: "none" });
    const id = window.setTimeout(() => {
      if (el.current && !prefersReducedMotion()) {
        gsap.to(el.current, { x: 40, autoAlpha: 0, duration: 0.3, onComplete: () => dismiss(toast.id) });
      } else dismiss(toast.id);
    }, duration);
    return () => {
      window.clearTimeout(id);
      tween?.kill();
    };
  }, [duration, dismiss, toast.id, toast.variant]);

  const explorerHref = toast.txHash ? `https://sepolia.basescan.org/tx/${toast.txHash}` : undefined;

  return (
    <div
      ref={el}
      role="status"
      className="pointer-events-auto relative overflow-hidden rounded-2xl border border-white/10 bg-basalt-2/95 p-4 shadow-[0_20px_50px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl"
    >
      <div className="flex items-start gap-3">
        <span className="mt-1.5 flex h-2 w-2 shrink-0">
          {toast.variant === "pending" ? (
            <span className="h-2 w-2 animate-ping rounded-full bg-ember" />
          ) : (
            <span className={`h-2 w-2 rounded-full ${tone.dot}`} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="label mb-1">{tone.label}</div>
          <div className="text-[14px] font-semibold text-bone">{toast.title}</div>
          {toast.message && <div className="mt-0.5 text-[13px] text-bone-dim">{toast.message}</div>}
          {explorerHref && (
            <a
              href={explorerHref}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block font-mono text-[11px] text-ember transition-colors hover:text-ember-hot"
            >
              View on BaseScan ↗
            </a>
          )}
        </div>
        <button
          type="button"
          onClick={() => dismiss(toast.id)}
          aria-label="Dismiss"
          className="text-lg leading-none text-ash transition-colors hover:text-bone"
        >
          ×
        </button>
      </div>
      {duration > 0 && <div ref={bar} className={`absolute bottom-0 left-0 h-0.5 w-full origin-left ${tone.bar} opacity-60`} />}
    </div>
  );
}
