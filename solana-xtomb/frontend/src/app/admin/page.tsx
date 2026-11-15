"use client";
import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Card, Cta, Modal, SectionTitle, SimBadge, SimNote } from "@/components/ui";
import { config } from "@/lib/config";

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="font-mono text-[10px] tracking-widest text-dust">{label}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="mt-1 w-full rounded-lg border border-white/15 bg-panel2 px-3 py-2 font-mono text-sm outline-none focus:border-ember" />
    </label>
  );
}

export default function AdminPage() {
  const { publicKey } = useWallet();
  const [action, setAction] = useState<string | null>(null);
  const [pool, setPool] = useState("");
  const [fee, setFee] = useState("3");
  const [wallets, setWallets] = useState({ team: "", dev: "", treasury: "", bot: "" });
  const [oracle, setOracle] = useState("");
  const [cap, setCap] = useState(String(config.masonry.expansion_cap_percent_per_epoch));
  const [epochH, setEpochH] = useState(String(config.masonry.epoch_hours));
  const [twap, setTwap] = useState("1.00");
  const [reserve, setReserve] = useState("");
  const [maintenance, setMaintenance] = useState(false);
  const owner = publicKey?.toBase58() ?? null;

  return (
    <div>
      <SectionTitle title="Admin" sub="Owner-gated. All live parameters configurable here. Admin maintains — the wizard deploys." />
      <div className="mb-4 flex gap-2"><SimBadge /><SimBadge label="OWNER-GATED" /></div>
      <Card>
        <p className="text-sm text-ash">
          {owner ? `Connected wallet: ${owner}. Owner check is simulated — no program is deployed, so no on-chain owner exists yet.` : "No wallet connected. Connect a wallet (Phantom / Solflare) to preview the owner-gated admin. Nothing here sends a transaction."}
        </p>
      </Card>

      <div className="mt-4 grid gap-3">
        <Card>
          <h3 className="font-display text-sm font-bold text-bone">Add pool</h3>
          <div className="mt-2"><Field label="POOL (e.g. xTOMB·USDC LP)" value={pool} onChange={setPool} placeholder="xTOMB·USDC LP" /></div>
          <div className="mt-3"><Cta onClick={() => setAction(`Add pool ${pool || "(unnamed)"}`)}>Add pool</Cta></div>
        </Card>
        <Card>
          <h3 className="font-display text-sm font-bold text-bone">Fee config</h3>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <Field label="GENESIS DEPOSIT FEE %" value={fee} onChange={setFee} />
            <Field label="EXPANSION CAP % / EPOCH" value={cap} onChange={setCap} />
          </div>
          <p className="mt-2 text-xs text-ash">Current: deposit {config.genesis.default_deposit_fee_percent}%, claim {config.genesis.claim_fee_percent}% (post-Genesis; Genesis claims pay the Fire Tax, burned), keeper {config.compound.keeper_fee_percent_of_liquid}%, Fire Tax {config.withdrawal_fire_tax.baseline_percent_xtomb}% xTOMB / {config.withdrawal_fire_tax.baseline_percent_xshare}% xSHARE at peg – {config.withdrawal_fire_tax.max_percent}% cap (admin-configurable, zeroable when healthy).</p>
          <div className="mt-3"><Cta onClick={() => setAction("Set fee config")}>Set fee config</Cta></div>
        </Card>
        <Card>
          <h3 className="font-display text-sm font-bold text-bone">Four wallets</h3>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <Field label="TEAM WALLET" value={wallets.team} onChange={(v) => setWallets({ ...wallets, team: v })} placeholder="Solana address" />
            <Field label="DEV WALLET" value={wallets.dev} onChange={(v) => setWallets({ ...wallets, dev: v })} placeholder="Solana address" />
            <Field label="TREASURY WALLET" value={wallets.treasury} onChange={(v) => setWallets({ ...wallets, treasury: v })} placeholder="Solana address" />
            <Field label="TRADING-BOT WALLET" value={wallets.bot} onChange={(v) => setWallets({ ...wallets, bot: v })} placeholder="Solana address" />
          </div>
          <p className="mt-2 text-xs text-ash">Config wallets are currently unset (empty in xtomb.config.json) — fill at deploy time. Fee proceeds route to wallets, not contracts.</p>
          <div className="mt-3"><Cta onClick={() => setAction("Set four wallets")}>Set wallets</Cta></div>
        </Card>
        <Card>
          <h3 className="font-display text-sm font-bold text-bone">Oracle authority</h3>
          <div className="mt-2"><Field label="ORACLE AUTHORITY (keeper key)" value={oracle} onChange={setOracle} placeholder="Solana address" /></div>
          <p className="mt-2 text-xs text-ash">Rotatable by admin. Freshness {config.oracle.freshness_minutes} min; withdrawals fail closed on stale data, buys stay available.</p>
          <div className="mt-3"><Cta onClick={() => setAction("Set / rotate oracle authority")}>Set / rotate oracle</Cta></div>
        </Card>
        <Card>
          <h3 className="font-display text-sm font-bold text-bone">Epoch, TWAP &amp; reserve</h3>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <Field label="EPOCH HOURS" value={epochH} onChange={setEpochH} />
            <Field label="TWAP (USDC)" value={twap} onChange={setTwap} />
            <Field label="RESERVE" value={reserve} onChange={setReserve} placeholder="amount" />
          </div>
          <p className="mt-2 text-xs text-ash">Epoch 0 opens only on manual Admin trigger. Next epoch time is derived from epoch length + last settle.</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Cta onClick={() => setAction("Set epoch time / next epoch time")}>Set epoch time</Cta>
            <Cta tone="ghost" onClick={() => setAction("Set TWAP / reserve")}>Set TWAP / reserve</Cta>
          </div>
        </Card>
        <Card>
          <h3 className="font-display text-sm font-bold text-bone">Operator / roles &amp; bonds</h3>
          <p className="mt-1 text-xs text-ash">Operator and role controls, bond buy/redeem caps, max outstanding — all admin-settable in config.</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Cta onClick={() => setAction("Operator / role controls")}>Roles</Cta>
            <Cta tone="ghost" onClick={() => setAction("Bond actions")}>Bond actions</Cta>
          </div>
        </Card>
        <Card>
          <h3 className="font-display text-sm font-bold text-bone">Maintenance toggle</h3>
          <p className="mt-1 text-xs text-ash">Maintenance mode: {maintenance ? "ON (simulated)" : "OFF"}. Pauses new deposits/compounds; claims and withdrawals stay available.</p>
          <div className="mt-3"><Cta tone={maintenance ? "ember" : "ghost"} onClick={() => { setMaintenance(!maintenance); setAction(maintenance ? "Maintenance OFF" : "Maintenance ON"); }}>Turn maintenance {maintenance ? "off" : "on"}</Cta></div>
        </Card>
      </div>
      <div className="mt-4"><SimNote /></div>
      {action && (
        <Modal title={action} onClose={() => setAction(null)}>
          <p className="text-sm text-ash">Admin action preview. In the deployed program this goes through an admin instruction with an on-chain event — never a silent config edit.</p>
          <div className="mt-4"><Cta>Simulated — no program deployed yet</Cta></div>
        </Modal>
      )}
    </div>
  );
}
