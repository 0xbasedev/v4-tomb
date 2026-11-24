import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const configDir = resolve(here, "../config");
// pnpm keeps packages in a content-addressed store; allow its resolved path so
// the self-hosted fonts load in dev.
const dependencyDir = realpathSync(resolve(here, "node_modules"));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Mirror the tsconfig paths entry — TS paths is type-only; Vite needs its own.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The one deployment manifest, shared with the deploy scripts and the keeper.
      // PROTOCOL_CONFIG points a dev server at another manifest (e.g. a local fork).
      "@protocol-manifest": resolve(here, process.env.PROTOCOL_CONFIG ?? "../config/networks.json"),
    },
  },
  server: {
    port: 5173,
    open: false,
    fs: { allow: [".", configDir, dependencyDir] },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/viem/") || id.includes("node_modules/ox/") || id.includes("node_modules/abitype/")) {
            return "viem";
          }
          if (id.includes("node_modules/wagmi/") || id.includes("node_modules/@wagmi/")) return "wagmi";
          if (id.includes("node_modules/gsap/")) return "gsap";
        },
      },
    },
  },
});
