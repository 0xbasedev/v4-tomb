import { Link } from "react-router-dom";

import { Sigil } from "@/components/brand/Sigil";
import { useProtocol } from "@/lib/hooks";
import { PASSES, PASS_ORDER } from "@/lib/launch";
import { PRIMARY } from "@/lib/networks";

const symbol = PRIMARY.referenceToken?.symbol ?? "USDC";

/**
 * The three Genesis passes on the homepage, shown until Genesis has ended. Read-only: each card links to /genesis, where PassPicker does the
 * minting and upgrading.
 */
export function HomePasses({ className = "" }: { className?: string }) {
  const { clock, pass } = useProtocol();
  // Unlike GenesisStrip this also shows with no wallet or deployment: it is the pitch, not live status.
  if (clock?.phase === "ended") return null;
  return (
    <div data-reveal className={className}>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-xl font-semibold tracking-[-0.02em] text-bone">Genesis is pass-gated. Pick one of three.</h2>
        <span className="text-[13px] text-bone-dim">Soulbound NFT · one per wallet · upgrade for the difference</span>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {PASS_ORDER.map((id) => {
          const def = PASSES[id];
          const ultra = id === "ultra";
          const owned = pass === id;
          return (
            <Link
              key={id}
              to="/genesis"
              className={`panel panel-hover relative flex items-start gap-4 p-5 ${owned ? "border-ok/50" : ultra ? "border-spectre/30" : ""}`}
            >
              <div className={`flex h-[96px] w-[72px] shrink-0 flex-col items-center justify-between rounded-xl border bg-gradient-to-b from-basalt-3 via-basalt to-void p-2 ${ultra ? "border-spectre/40" : id === "pro" ? "border-ember-hot/40" : "border-white/10"}`}>
                <span className="font-mono text-[7px] uppercase tracking-[0.2em] text-ash">{id}</span>
                <Sigil size={30} glow={owned || ultra} className={owned || ultra ? "text-bone" : "text-ash"} />
                <span className="font-mono text-[7px] text-ash">soulbound</span>
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="font-display text-[17px] font-semibold tracking-[-0.02em] text-bone">{def.name}</h3>
                  {owned && <span className="chip chip-ok h-5 px-2 text-[10px]">Held</span>}
                </div>
                <div className="mt-1 flex items-baseline gap-1.5">
                  <span className={`font-display text-3xl font-semibold tracking-[-0.04em] ${ultra ? "spectre-text" : "text-bone"}`}>{def.priceUsdc}</span>
                  <span className="font-mono text-[11px] text-ash">{symbol}</span>
                </div>
                <p className="mt-2 text-[12.5px] leading-snug text-bone-dim">{def.perks[def.perks.length > 1 ? 1 : 0]}</p>
                <span className="mt-3 inline-block font-mono text-[12px] text-ember-hot">{owned ? "Go to Genesis →" : `Get ${def.name} →`}</span>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
