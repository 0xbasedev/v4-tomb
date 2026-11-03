import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Mirror the tsconfig paths entry — TS paths is type-only; Vite needs its own.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@protocol-manifest": resolve(dirname(fileURLToPath(import.meta.url)), process.env.PROTOCOL_CONFIG ?? "../config/networks.json"),
    },
  },
  server: {
    port: 5173,
    open: false,
  },
});
