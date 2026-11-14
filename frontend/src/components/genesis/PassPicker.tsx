import { useRef, useState } from "react";

import { Sigil } from "@/components/brand/Sigil";
import { Reason, SimBadge } from "@/components/Status";
import { useActions, useNetworkStatus, useProtocol } from "@/lib/hooks";
import { PASSES, PASS_ORDER, type PassDef, type PassTier } from "@/lib/launch";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import { useMagnetic } from "@/lib/motion/useMagnetic";

/**
 * Genesis passes — MasonryGenesisPass: soulbound ERC-721, one per wallet,
 * bought in USDC (paid straight to the DAO wallet) until Genesis ends. Buy any tier
 * outright, or upgrade in place by paying only the difference. Every pass
 * earns with the same reward weighting; tiers differ only in keeper
 * compounding (Pro, Ultra) and Ultra's 24-hour early standard staking.
 */
export function PassPicker() {
  const p = useProtocol();
  const net = useNetworkStatus();
  const root = useRef<HTMLDivElement>(null);
  const closed = p.clock?.phase === "ended";
  // A top-tier holder has nothing left to buy, so the picker folds into a
  // one-line summary (the comparison stays one tap away). Anyone who can still
  // upgrade keeps the cards open.
  const [compare, setCompare] = useState(false);
  const canUpgrade = !!p.pass && PASSES[p.pass].rank < PASSES.ultra.rank && !closed;
  const folded = !!p.pass && !canUpgrade && !compare;
  useGSAP(
    () => {
      if (prefersReducedMotion() || folded) return;
      gsap.from(".pass-card", { y: 22, autoAlpha: 0, duration: 0.6, stagger: 0.08, ease: EASE.rise });
    },
    { scope: root, dependencies: [folded] },
  );

  return (
    <section ref={root} data-reveal className="panel panel-raised p-5 md:p-7">
      <div className={`flex flex-col gap-3 md:flex-row md:items-end md:justify-between ${folded ? "" : "mb-5"}`}>
        <div>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="label">Step 1 · Pass</span>
            {p.pass ? <span className="chip chip-ok h-6">{PASSES[p.pass].name} held</span> : <span className="chip chip-warn h-6">Required to stake</span>}
            {p.sim && <SimBadge />}
          </div>
          <h2 className="font-display text-2xl font-semibold tracking-[-0.02em] text-bone">{p.pass ? `You hold the ${PASSES[p.pass].name} pass.` : "Choose a Genesis pass"}</h2>
          <p className="mt-2 max-w-xl text-[14px] leading-relaxed text-bone-dim">
            {p.pass
              ? `${PASSES[p.pass].perks.slice(1).join(" · ") || PASSES[p.pass].perks.join(" · ")}. ${canUpgrade ? "Upgrade any time before Genesis ends and pay only the difference. " : ""}Passes are soulbound and can't be transferred — your next step is staking below.`
              : "Soulbound, one per wallet, paid in USDC. Buy the one you want, or start at Genesis and upgrade later for just the difference. Every pass earns at the same rate — passes don't change rewards, only automation and Ultra's early start."}
          </p>
        </div>
        {p.pass && !canUpgrade && (
          <button type="button" onClick={() => setCompare((v) => !v)} aria-expanded={compare} className="btn h-10 shrink-0 self-start px-4 text-[13px] md:self-auto">
            {compare ? "Hide passes" : "Compare passes"}
          </button>
        )}
      </div>
      {!folded && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {PASS_ORDER.map((id) => (
            <PassCard
              key={id}
              pass={PASSES[id]}
              held={p.pass}
              closed={closed}
              reason={p.genesisScheduled === false ? "Pass sales open once Genesis is scheduled — the pass contract rejects purchases while the start is unset." : !net.preview ? net.reason : null}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PassCard({ pass, held, closed, reason }: { pass: PassDef; held: string | null; closed: boolean; reason: string | null }) {
  const actions = useActions();
  const cta = useRef<HTMLButtonElement>(null);
  useMagnetic(cta, 0.16);
  const ultra = pass.id === "ultra";
  const owned = held === pass.id;
  const heldDef = held ? PASSES[held as PassTier] : null;
  const upgrade = !!heldDef && pass.rank > heldDef.rank;
  const diff = heldDef ? pass.priceUsdc - heldDef.priceUsdc : 0;
  const blocked = owned
    ? "Held"
    : heldDef && !upgrade
      ? "You already hold a higher pass — passes can't be downgraded or transferred"
      : closed
        ? "Passes are sold until Genesis ends"
        : reason;
  return (
    <article className={`pass-card relative flex flex-col rounded-2xl border bg-basalt-2/70 p-5 ${owned ? "border-ok/50" : ultra ? "border-spectre/30" : "border-white/[0.08]"}`}>
      {ultra && <div className="pointer-events-none absolute inset-0 rounded-2xl bg-[radial-gradient(120%_70%_at_50%_0%,rgba(62,231,255,0.10),transparent_60%)]" />}
      <div className="relative flex items-start gap-4">
        <div className={`flex h-[96px] w-[72px] shrink-0 flex-col items-center justify-between rounded-xl border bg-gradient-to-b from-basalt-3 via-basalt to-void p-2 ${ultra ? "border-spectre/40" : pass.id === "pro" ? "border-ember-hot/40" : "border-white/10"}`}>
          <span className="font-mono text-[7px] uppercase tracking-[0.2em] text-ash">{pass.id}</span>
          <Sigil size={30} glow={owned || ultra} className={owned || ultra ? "text-bone" : "text-ash"} />
          <span className="font-mono text-[7px] text-ash">soulbound</span>
        </div>
        <div className="min-w-0 pt-1">
          <h3 className="font-display text-[17px] font-semibold tracking-[-0.02em] text-bone">{pass.name}</h3>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className={`font-display text-3xl font-semibold tracking-[-0.04em] ${ultra ? "spectre-text" : "text-bone"}`}>{pass.priceUsdc}</span>
            <span className="font-mono text-[11px] text-ash">USDC</span>
          </div>
          <span className="chip mt-2 h-5 px-2 text-[10px]">Soulbound ERC-721</span>
        </div>
      </div>
      <ul className="relative mt-4 flex-1 space-y-1.5">
        {pass.perks.map((perk) => (
          <li key={perk} className="flex gap-2 text-[12.5px] text-bone-dim">
            <span className={ultra ? "text-spectre" : "text-ember"} aria-hidden>
              ✦
            </span>
            {perk}
          </li>
        ))}
      </ul>
      <button
        ref={cta}
        type="button"
        onClick={() => (upgrade && heldDef ? actions.upgradePass(heldDef.id, pass.id) : actions.purchasePass(pass.id))}
        disabled={!!blocked || actions.busy}
        className={`relative mt-4 h-11 w-full text-[13px] ${ultra ? "btn btn-spectre" : pass.id === "pro" ? "btn btn-primary" : "btn"}`}
      >
        {owned ? "Held" : upgrade ? `Upgrade for ${diff} USDC` : `Mint ${pass.name}`}
      </button>
      {blocked && !owned && <Reason>{blocked}</Reason>}
    </article>
  );
}
