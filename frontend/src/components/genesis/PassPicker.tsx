import { useRef, useState } from "react";

import { PRIMARY } from "@/lib/networks";
const pReferenceSymbol = PRIMARY.referenceToken?.symbol ?? "USDC";

import { Sigil } from "@/components/brand/Sigil";
import { Reason, SimBadge } from "@/components/Status";
import { useActions, useNetworkStatus, useProtocol } from "@/lib/hooks";
import { PASSES, PASS_ORDER, type PassTier, type PassDef } from "@/lib/launch";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";
import { useMagnetic } from "@/lib/motion/useMagnetic";

/**
 * Genesis passes — MasonryGenesisPass: soulbound ERC-721, one per wallet,
 * bought in USDC (paid straight to Treasury) until Genesis ends. Every pass
 * earns with the same reward weighting; tiers differ only in keeper
 * compounding (Pro, Ultra) and Ultra's 24-hour early standard staking.
 */
export function PassPicker() {
  const p = useProtocol();
  const net = useNetworkStatus();
  const root = useRef<HTMLDivElement>(null);
  const closed = p.clock?.phase === "ended";
  // Once a pass is held the picker has nothing left to sell (no upgrades), so it
  // folds into a one-line summary; the comparison stays one tap away.
  const [compare, setCompare] = useState(false);
  const folded = !!p.pass && !compare;
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
              ? `${PASSES[p.pass].perks.slice(1).join(" · ") || PASSES[p.pass].perks.join(" · ")}. Passes are soulbound; higher tiers can be unlocked by paying the difference while the sale is open.`
              : "Soulbound, one per wallet, paid in the chain reference token. Every pass earns at the same rate — passes don't change rewards, only automation and Ultra's early start."}
          </p>
        </div>
        {p.pass && (
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
              reason={p.saleOpen !== true ? "Sale not open yet" : !net.preview ? net.reason : null}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PassCard({ pass, held, closed, reason }: { pass: PassDef; held: PassTier | null; closed: boolean; reason: string | null }) {
  const actions = useActions();
  const cta = useRef<HTMLButtonElement>(null);
  useMagnetic(cta, 0.16);
  const ultra = pass.id === "ultra";
  const owned = held === pass.id;
  const upgrade = !!held && pass.rank > PASSES[held].rank;
  const blocked = owned ? "Held" : held && !upgrade ? "Downgrades are not available" : closed ? "Passes are sold until Genesis ends" : reason;
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
            <span className={`font-display text-3xl font-semibold tracking-[-0.04em] ${ultra ? "spectre-text" : "text-bone"}`}>{held && upgrade ? pass.priceUsdc - PASSES[held].priceUsdc : pass.priceUsdc}</span>
            <span className="font-mono text-[11px] text-ash">{pReferenceSymbol}</span>
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
        onClick={() => held ? actions.upgradePass(pass.id, held) : actions.purchasePass(pass.id)}
        disabled={!!blocked || actions.busy}
        className={`relative mt-4 h-11 w-full text-[13px] ${ultra ? "btn btn-spectre" : pass.id === "pro" ? "btn btn-primary" : "btn"}`}
      >
        {owned ? "Held" : `${upgrade ? "Upgrade to" : "Mint"} ${pass.name}`}
      </button>
      {blocked && !owned && <Reason>{blocked}</Reason>}
    </article>
  );
}
