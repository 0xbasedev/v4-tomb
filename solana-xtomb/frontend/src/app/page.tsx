import Link from "next/link";
import { Card, SectionTitle, SimBadge, SimNote } from "@/components/ui";
import { config } from "@/lib/config";

export default function Dashboard() {
  const g = config.genesis;
  const ft = config.withdrawal_fire_tax;
  return (
    <div>
      <SectionTitle title="Dashboard" sub="xTOMB on Solana — Obsidian Crypt. Peg target 1 USDC." />
      <div className="mb-4 flex flex-wrap gap-2">
        <SimBadge /> <SimBadge label="DEVNET" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Card><p className="font-mono text-[10px] tracking-widest text-dust">xTOMB TWAP (SIM)</p><p className="mt-1 font-mono text-2xl font-bold text-bone">$1.000</p><p className="text-xs text-ash">Peg reference $1.00 USDC</p></Card>
        <Card><p className="font-mono text-[10px] tracking-widest text-dust">xSHARE CAP</p><p className="mt-1 font-mono text-2xl font-bold text-bone">33,333</p><p className="text-xs text-ash">Farm emissions {config.farm.emissions_xshare_365d.toLocaleString()} / 365d</p></Card>
        <Card><p className="font-mono text-[10px] tracking-widest text-dust">GENESIS REWARD BUDGET</p><p className="mt-1 font-mono text-2xl font-bold text-bone">{config.xtomb_launch.genesis_reward_budget.toLocaleString()} xTOMB</p><p className="text-xs text-ash">{g.duration_days} days · {g.reward_split_liquid_percent}/{g.reward_split_vested_percent} liquid/vested</p></Card>
        <Card><p className="font-mono text-[10px] tracking-widest text-dust">WITHDRAWAL {ft.display_name.toUpperCase()}</p><p className="mt-1 font-mono text-2xl font-bold text-bone">{ft.baseline_percent_xtomb}% xTOMB / {ft.baseline_percent_xshare}% xSHARE – {ft.max_percent}% cap</p><p className="text-xs text-ash">Buys &amp; transfers 0%. Genesis min {ft.genesis_minimum_xtomb_percent}% xTOMB / {ft.genesis_minimum_xshare_percent}% xSHARE</p></Card>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {[
          { href: "/genesis", title: "Genesis", body: `Passes $${config.passes.Genesis.price_usdc} / $${config.passes.Pro.price_usdc} / $${config.passes.Ultra.price_usdc} USDC, soulbound.`, cta: "Open Genesis" },
          { href: "/swap", title: "Swap", body: "Buy / Sell / Enter & Exit LP with Fire Tax shown before signing.", cta: "Open Swap" },
          { href: "/masonry", title: "Masonry", body: `Lazy 6h epochs. Bootstrap ${config.masonry.bootstrap_epochs} epochs at ${config.masonry.bootstrap_rate_percent_per_epoch}% above $${config.masonry.bootstrap_only_above_twap}.`, cta: "Open Masonry" },
        ].map((c) => (
          <Card key={c.href}>
            <h3 className="font-display text-base font-bold text-bone">{c.title}</h3>
            <p className="mt-1 text-sm text-ash">{c.body}</p>
            <Link href={c.href} className="mt-3 inline-block font-display text-xs font-bold text-ember">{c.cta} →</Link>
          </Card>
        ))}
      </div>
      <div className="mt-4"><SimNote /></div>
    </div>
  );
}
