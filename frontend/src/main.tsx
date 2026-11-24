import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";

import { wagmiConfig } from "./lib/wagmi";

import { ToastProvider } from "./components/ToastProvider";
import { Layout } from "./components/Layout";

import "./styles/index.css";

const Landing = lazy(() => import("./routes/Landing").then((module) => ({ default: module.Landing })));
const Dashboard = lazy(() => import("./routes/Dashboard").then((module) => ({ default: module.Dashboard })));
const Masonry = lazy(() => import("./routes/Masonry").then((module) => ({ default: module.Masonry })));
const Farms = lazy(() => import("./routes/Farms").then((module) => ({ default: module.Farms })));
const Swap = lazy(() => import("./routes/Swap").then((module) => ({ default: module.Swap })));
const Admin = lazy(() => import("./routes/Admin").then((module) => ({ default: module.Admin })));
const Docs = lazy(() => import("./routes/Docs").then((module) => ({ default: module.Docs })));

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
        <BrowserRouter>
          <Suspense
            fallback={
              <p className="label-deco px-6 py-16 text-center text-deco-gold">Opening the ledger…</p>
            }
          >
          <Routes>
            {/* Landing has its own full-bleed nav/footer — no Layout wrap */}
            <Route path="/" element={<Landing />} />

            {/* All other routes render inside the shared Layout */}
            <Route element={<Layout />}>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/masonry" element={<Masonry />} />
              <Route path="/farms" element={<Farms />} />
              {/* Former paths. Kept so existing links and bookmarks still land. */}
              <Route path="/club" element={<Navigate to="/masonry" replace />} />
              <Route path="/vault" element={<Navigate to="/farms" replace />} />
              {/* There are no bonds. The old pages land on the dashboard. */}
              <Route path="/notes" element={<Navigate to="/dashboard" replace />} />
              <Route path="/bonds" element={<Navigate to="/dashboard" replace />} />
              <Route path="/swap" element={<Swap />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="/docs" element={<Docs />} />
            </Route>
          </Routes>
          </Suspense>
        </BrowserRouter>
        </ToastProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
