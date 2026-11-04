import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, HashRouter, MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";

import { wagmiConfig } from "./lib/wagmi";
import { PreviewProvider } from "./lib/preview";

import { ToastProvider } from "./components/ToastProvider";
import { Layout } from "./components/Layout";
import { Landing } from "./routes/Landing";
import { Dashboard } from "./routes/Dashboard";
import { Genesis } from "./routes/Genesis";
import { Masonry } from "./routes/Masonry";
import { Farm } from "./routes/Farm";
import { Bridge } from "./routes/Bridge";
import { Wizard } from "./routes/Wizard";
import { Bonds } from "./routes/Bonds";
import { Swap } from "./routes/Swap";
import { Admin } from "./routes/Admin";
import { Docs } from "./routes/Docs";

// Self-hosted variable fonts — no Google Fonts round-trip, works offline.
import "@fontsource-variable/unbounded";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/index.css";

const queryClient = new QueryClient();

// Router is selectable at build time so the same app can ship as a static demo:
//   default  → BrowserRouter (needs SPA fallback on the host)
//   "hash"   → HashRouter (IPFS / static hosts with no rewrites)
//   "memory" → MemoryRouter (sandboxed iframes, e.g. the shareable demo build)
const Router =
  import.meta.env.VITE_ROUTER === "memory"
    ? MemoryRouter
    : import.meta.env.VITE_ROUTER === "hash"
      ? HashRouter
      : BrowserRouter;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <PreviewProvider>
          <ToastProvider>
            <Router>
              <Routes>
                {/* Landing has its own full-bleed chrome */}
                <Route path="/" element={<Landing />} />

                <Route element={<Layout />}>
                  <Route path="/dashboard" element={<Dashboard />} />
                  <Route path="/genesis" element={<Genesis />} />
                  <Route path="/farm" element={<Farm />} />
                  <Route path="/masonry" element={<Masonry />} />
                  <Route path="/bonds" element={<Bonds />} />
                  <Route path="/bridge" element={<Bridge />} />
                  <Route path="/swap" element={<Swap />} />
                  <Route path="/admin" element={<Admin />} />
                  <Route path="/wizard" element={<Wizard />} />
                  <Route path="/docs" element={<Docs />} />

                  {/* Older paths → current homes, so old links keep working */}
                  <Route path="/crypt" element={<Navigate to="/masonry" replace />} />
                  <Route path="/club" element={<Navigate to="/masonry" replace />} />
                  <Route path="/forge" element={<Navigate to="/farm" replace />} />
                  <Route path="/vault" element={<Navigate to="/farm" replace />} />
                  <Route path="/notes" element={<Navigate to="/bonds" replace />} />
                  <Route path="*" element={<Navigate to="/dashboard" replace />} />
                </Route>
              </Routes>
            </Router>
          </ToastProvider>
        </PreviewProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
