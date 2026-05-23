import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";

import { wagmiConfig } from "./lib/wagmi";

import { ToastProvider } from "./components/ToastProvider";
import { Layout } from "./components/Layout";
import { Landing } from "./routes/Landing";
import { Dashboard } from "./routes/Dashboard";
import { TheClub } from "./routes/TheClub";
import { TheVault } from "./routes/TheVault";
import { TrustNotes } from "./routes/TrustNotes";
import { Swap } from "./routes/Swap";
import { Admin } from "./routes/Admin";

import "./styles/index.css";

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
        <BrowserRouter>
          <Routes>
            {/* Landing has its own full-bleed nav/footer — no Layout wrap */}
            <Route path="/" element={<Landing />} />

            {/* All other routes render inside the shared Layout */}
            <Route element={<Layout />}>
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/club" element={<TheClub />} />
              <Route path="/vault" element={<TheVault />} />
              <Route path="/notes" element={<TrustNotes />} />
              <Route path="/swap" element={<Swap />} />
              <Route path="/admin" element={<Admin />} />
            </Route>
          </Routes>
        </BrowserRouter>
        </ToastProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </React.StrictMode>,
);
