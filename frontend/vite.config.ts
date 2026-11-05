import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

const configDir = fileURLToPath(new URL("../config", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Mirror the tsconfig paths entry — TS paths is type-only; Vite needs its own.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // The launch plan, deployment schema and chain registry are shared with
      // the deploy scripts and keeper — the UI imports them, never copies.
      "@config": configDir,
    },
  },
  server: {
    port: 5173,
    open: false,
    fs: { allow: [".", configDir] },
  },
});
