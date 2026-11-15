import { useState } from "react";
import { useReadContract } from "wagmi";
import type { Address } from "viem";

import { Modal, Row } from "@/components/Modal";
import { DepositBadge, Reason } from "@/components/Status";
import { TokenIcon } from "@/components/TokenIcon";
import { masonryTreasuryAbi } from "@/lib/abis/masonry";
import { useProtocol } from "@/lib/hooks";
import { EPOCH_SECONDS, POLICY } from "@/lib/launch";
import { PEG } from "@/lib/peg";
import { TOKENS, type TokenId } from "@/lib/tokens";

/** What it costs to start an epoch, in the peg token. */
export const START_EPOCH_FEE_USD = POLICY.epochAdvanceFeeUsd;

/** Tokens the payer can bring. Anything but the peg token is zapped into it first. */
const PAY_WITH: TokenId[] = ["USDC", "xTOMB", "xSHARE", "ETH"];

const WHY =
  "Not live yet: MasonryTreasury has no published address. Paying in a token other than the peg token also needs a zap route that is not built yet.";

/**
 * Start Epoch — the green button on Masonry. Whoever starts the next epoch
 * pays a flat $20, in any token; anything that isn't the peg token is zapped
 * into exactly $20 of it.
 */
export function StartEpoch() {
  const p = useProtocol();
  const [open, setOpen] = useState(false);
  const treasury = p.net.deployment?.contracts?.treasury as Address | undefined;
  const epoch = useReadContract({
    address: treasury,
    abi: masonryTreasuryAbi,
    functionName: "epoch",
    query: { enabled: Boolean(treasury) },
  });
  // The treasury counts epochs it has already started; the button starts the next one.
  const next = Number(epoch.data ?? 0n) + 1;
  const hours = EPOCH_SECONDS / 3600;

  return (
    <section data-reveal className="panel flex flex-wrap items-center justify-between gap-4 p-5 md:p-6">
      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <h2 className="font-display text-xl font-semibold text-bone">Epoch {next}</h2>
          <DepositBadge />
        </div>
        <p className="text-[13px] leading-relaxed text-bone-dim">
          Epochs last {hours} hours and do not start themselves. Whoever starts the next one pays ${START_EPOCH_FEE_USD}. Until someone does,
          the epoch count stands still and no xTOMB is minted.
        </p>
      </div>
      <button type="button" onClick={() => setOpen(true)} className="btn btn-ok h-12 shrink-0 px-6">
        Start Epoch {next}
      </button>
      {open && <StartEpochModal epoch={next} onClose={() => setOpen(false)} />}
    </section>
  );
}

function StartEpochModal({ epoch, onClose }: { epoch: number; onClose: () => void }) {
  const p = useProtocol();
  const [token, setToken] = useState<TokenId>("USDC");
  const price = p.prices[token];
  const direct = token === "USDC";
  const amount = price ? START_EPOCH_FEE_USD / price : null;

  return (
    <Modal kicker="Masonry" title={`Start Epoch ${epoch}`} onClose={onClose} tone="ok" width={480}>
      <p className="mb-4 text-[13.5px] leading-relaxed text-bone-dim">
        Starting an epoch costs <span className="text-bone">${START_EPOCH_FEE_USD}</span>. Pay with any token below; it is zapped into
        exactly ${START_EPOCH_FEE_USD} of {PEG.symbol}.
      </p>

      <div className="label mb-2">Pay with</div>
      <div className="mb-4 grid grid-cols-2 gap-2">
        {PAY_WITH.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setToken(id)}
            aria-pressed={token === id}
            className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-[13.5px] transition-colors ${
              token === id ? "border-ok/60 bg-ok/10 text-bone" : "border-white/[0.07] bg-white/[0.02] text-bone-dim hover:border-ok/30"
            }`}
          >
            <TokenIcon symbol={id} size={20} />
            {TOKENS[id].symbol}
          </button>
        ))}
      </div>

      <dl className="space-y-2 rounded-xl bg-black/25 p-4 text-[13.5px]">
        <Row
          k="You pay"
          v={amount === null ? `$${START_EPOCH_FEE_USD} of ${TOKENS[token].symbol}` : `${fmt(amount)} ${TOKENS[token].symbol}`}
          sub={amount === null ? "amount set at confirmation" : undefined}
        />
        {!direct && <Row k="Zapped into" v={`${START_EPOCH_FEE_USD} ${PEG.symbol}`} />}
        <Row k="Epoch fee" v={`$${START_EPOCH_FEE_USD}`} strong />
      </dl>

      <button type="button" disabled className="btn btn-ok mt-5 h-12 w-full">
        Pay ${START_EPOCH_FEE_USD} and start Epoch {epoch}
      </button>
      <Reason>{WHY}</Reason>
    </Modal>
  );
}

function fmt(n: number) {
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 2 : 4 });
}
