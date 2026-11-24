import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, HashRouter, MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";

import { wagmiConfig } from "./lib/wagmi";
import { NetworkProvider } from "./lib/networks";

import { ToastProvider } from "./components/ToastProvider";
import { Layout } from "./components/Layout";
import { Landing } from "./routes/Landing";
import { Dashboard } from "./routes/Dashboard";
import { Genesis } from "./routes/Genesis";
import { Farm } from "./routes/Farm";
import { Masonry } from "./routes/Masonry";
import { Swap } from "./routes/Swap";
import { Admin } from "./routes/Admin";
import { Docs } from "./routes/Docs";

// Self-hosted variable fonts — no third-party font request, works offline.
import "@fontsource-variable/unbounded";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/index.css";

const queryClient = new QueryClient();

// Router is selectable at build time so the same app can ship to a static host:
//   default  → BrowserRouter (needs an SPA fallback on the host)
//   "hash"   → HashRouter (static hosts with no rewrites)
//   "memory" → MemoryRouter (sandboxed iframes)
const Router = import.meta.env.VITE_ROUTER === "memory" ? MemoryRouter : import.meta.env.VITE_ROUTER === "hash" ? HashRouter : BrowserRouter;

const to = (path: string) => <Navigate to={path} replace />;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <NetworkProvider>
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
                  <Route path="/swap" element={<Swap />} />
                  <Route path="/admin" element={<Admin />} />
                  <Route path="/docs" element={<Docs />} />

                  {/* Older paths land on their current homes, so old links keep working. */}
                  <Route path="/club" element={to("/masonry")} />
                  <Route path="/crypt" element={to("/masonry")} />
                  <Route path="/room" element={to("/masonry")} />
                  <Route path="/vault" element={to("/farm")} />
                  <Route path="/forge" element={to("/farm")} />
                  <Route path="/farms" element={to("/farm")} />
                  <Route path="/genesis-legacy" element={to("/genesis")} />
                  {/* Features this protocol does not have. Their old paths land on the dashboard. */}
                  <Route path="/bonds" element={to("/dashboard")} />
                  <Route path="/notes" element={to("/dashboard")} />
                  <Route path="/auction" element={to("/dashboard")} />
                  <Route path="/wizard" element={to("/dashboard")} />
                  <Route path="/manager" element={to("/dashboard")} />
                  <Route path="*" element={to("/dashboard")} />
                </Route>
              </Routes>
            </Router>
          </ToastProvider>
        </NetworkProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
