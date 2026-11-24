/// <reference types="vite/client" />

declare module "@protocol-manifest" {
  const manifest: unknown;
  export default manifest;
}

interface ImportMetaEnv {
  /** Per-chain RPC override, e.g. VITE_RPC_56. Unset chains use the manifest's rpcUrl. */
  readonly [key: `VITE_RPC_${number}`]: string | undefined;
  /** "hash" | "memory" — router for static hosts without rewrites (default: browser history). */
  readonly VITE_ROUTER?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
