import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { Modal } from "@/components/Modal";
import { useProtocol } from "@/lib/hooks";

/**
 * Zap In — the top-bar button (next to the price) and its destination modal
 * (Jess, 2026-11-09). One entry point for getting into the protocol from a
 * single asset: while Genesis runs it lists the Genesis pools; after Genesis
 * it lists the two Farms and the Masonry. Picking a destination navigates
 * there, where the zap itself runs — there is no zap contract, so the legs
 * (swap, pair, stake) are separate transactions and each is shown before
 * signing (lib/routes.ts).
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
}: {
  glyph: string;
  label: string;
  sub: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex w-full items-center gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3.5 text-left transition-colors hover:border-ember/40 hover:bg-ember/[0.06]"
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
    <Modal kicker="⚡ Zap In" title={ended ? "Where do you want in?" : "Zap into Genesis"} onClose={onClose}>
      {(close: () => void): ReactNode => (
        <div className="flex flex-col gap-2.5">
          {!ended ? (
            <>
              <Destination
                glyph="▲"
                label="Genesis · Standard pool"
                sub={
                  lpOpen
                    ? "Single-stake · 25% of Genesis emissions"
                    : "Single-stake · 100% of Genesis emissions until the LP pool opens"
                }
                onPick={pick(close, "/genesis")}
              />
              {lpOpen ? (
                <Destination
                  glyph="◆"
                  label="Genesis · xTOMB/USDC LP pool"
                  sub="Paired liquidity · 75% of Genesis emissions"
                  onPick={pick(close, "/genesis")}
                />
              ) : (
                <p className="px-1 pt-1 text-[12px] leading-relaxed text-ash">
                  The xTOMB/USDC LP pool opens on Day 2 and takes 75% of emissions from then on.
                </p>
              )}
            </>
          ) : (
            <>
              <Destination
                glyph="▲"
                label="xTOMB Farm"
                sub="xTOMB LP · 75% of xSHARE emissions"
                onPick={pick(close, "/farm")}
              />
              <Destination
                glyph="◆"
                label="xSHARE Farm"
                sub="xSHARE LP · 20% of xSHARE emissions"
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
          <p className="px-1 pt-2 text-[12px] leading-relaxed text-ash">
            A zap is a few transactions under the hood — swap, pair, stake. Each step is shown
            before you sign it.
          </p>
        </div>
      )}
    </Modal>
  );
}
