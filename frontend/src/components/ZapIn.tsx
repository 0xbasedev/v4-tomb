import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { Modal } from "@/components/Modal";
import { useProtocol } from "@/lib/hooks";

/**
 * Zap In — the top-bar button (next to the price) and its destination modal
 * (Jess, 2026-11-09). Zap is everywhere: one engine (the ZapBase pattern)
 * whose target decides the product — a token target is the Swap, an LP
 * target is a zap-in, a staking destination is a zap-and-stake that ends
 * STAKED on the user's behalf, any combo of input and destination. The
 * modal lists every destination open in the current phase, Swap included.
 * Picking one navigates there, where the zap itself runs.
 */
export function ZapInButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex shrink-0 items-center gap-1.5 rounded-lg border border-ember/40 bg-ember/10 px-2.5 py-1 text-[13px] font-semibold text-ember-hot transition-colors hover:bg-ember/20"
      >
        <span aria-hidden>⚡</span>
        Zap In
      </button>
      {open && <ZapInModal onClose={() => setOpen(false)} />}
    </>
  );
}

function Destination({
  glyph,
  label,
  sub,
  onPick,
  hot = false,
}: {
  glyph: string;
  label: string;
  sub: string;
  onPick: () => void;
  /** The destination currently taking the majority of emissions glows. */
  hot?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className={`flex w-full items-center gap-3 rounded-xl border bg-white/[0.02] px-4 py-3.5 text-left transition-colors hover:border-ember/40 hover:bg-ember/[0.06] ${
        hot ? "animate-pool-glow" : "border-white/[0.07]"
      }`}
    >
      <span className="text-[18px] leading-none text-ember" aria-hidden>
        {glyph}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-semibold text-bone">{label}</span>
        <span className="block truncate text-[12px] text-ash">{sub}</span>
      </span>
      <span className="text-ash" aria-hidden>
        →
      </span>
    </button>
  );
}

function ZapInModal({ onClose }: { onClose: () => void }) {
  const { clock } = useProtocol();
  const navigate = useNavigate();
  const ended = clock?.phase === "ended";
  const lpOpen = clock?.lpOpen ?? false;

  const pick = (close: () => void, to: string) => () => {
    close();
    navigate(to);
  };

  return (
    <Modal kicker="⚡ Zap In" title="Where do you want in?" onClose={onClose}>
      {(close: () => void): ReactNode => (
        <div className="flex flex-col gap-2.5">
          <Destination glyph="⇄" label="Swap" sub="Any token → any token" onPick={pick(close, "/swap")} />
          {!ended ? (
            <>
              <Destination
                glyph="▲"
                label="Genesis · Standard pool"
                sub="Single-stake · open from Day 1"
                hot={clock?.phase === "day1"}
                onPick={pick(close, "/genesis")}
              />
              {lpOpen ? (
                <Destination
                  glyph="◆"
                  label="Genesis · xTOMB/USDC LP pool"
                  sub="Paired liquidity · the LP pool"
                  hot={lpOpen}
                  onPick={pick(close, "/genesis")}
                />
              ) : (
                <p className="px-1 pt-1 text-[12px] leading-relaxed text-ash">
                  The xTOMB/USDC LP pool opens on Day 2.
                </p>
              )}
            </>
          ) : (
            <>
              <Destination
                glyph="▲"
                label="xTOMB Farm"
                sub="xTOMB LP · earns xSHARE"
                onPick={pick(close, "/farm")}
              />
              <Destination
                glyph="◆"
                label="xSHARE Farm"
                sub="xSHARE LP · earns xSHARE"
                onPick={pick(close, "/farm")}
              />
              <Destination
                glyph="⬡"
                label="The Masonry"
                sub="Stake LP · the loyalty clock runs here"
                onPick={pick(close, "/masonry")}
              />
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
