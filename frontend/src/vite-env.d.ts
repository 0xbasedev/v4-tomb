/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Per-chain RPC overrides, e.g. VITE_RPC_8453 for Base. Unset chains use the viem default transport. */
  readonly [key: `VITE_RPC_${number}`]: string | undefined;
  /** "1" forces Preview mode (simulated chain) even when deployments are configured. */
  readonly VITE_PREVIEW?: string;
  /** "hash" | "memory" — router for static/sandboxed demo builds (default: browser history). */
  readonly VITE_ROUTER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
