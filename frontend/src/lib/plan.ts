import { trancheView } from "@/lib/genesis";
import { useProtocol } from "@/lib/hooks";
import { DEFENSE, EXPANSION, FIRE, pct } from "@/lib/launch";

/**
 * The interface's opinion: one primary move, one alternative, one thing to
 * avoid — computed from the Genesis clock, the market phase and the wallet's
 * own position. Every claim it makes matches what the contracts do today.
 */

export type Tone = "ember" | "spectre" | "amethyst" | "neutral";
export interface Move {
  title: string;
  why: string;
  cta: string;
  to: string;
  tone: Tone;
}
export interface Plan {
  headline: string;
  primary: Move;
  secondary: Move;
  avoid: { title: string; why: string };
}

export function usePlan(): Plan {
  const p = useProtocol();
  const c = p.clock;
  const tax = p.taxFor("xTOMB", 1_000);
  const rate = tax.rateBps;
  const avoidSell =
    p.market.phase === "stale"
      ? { title: "Selling xTOMB now", why: "the oracle has no valid TWAP, so the hook rejects sells until it refreshes." }
      : p.market.phase === "defense"
        ? { title: "Selling into Critical Defense", why: `the Fire Tax is near its ${pct(FIRE.capBps)} cap and every xSHARE sell is buying back xTOMB.` }
        : rate !== null && tax.driver === "genesis"
          ? { title: `Selling xTOMB at ${pct(rate)}`, why: "that's the Genesis floor and the whole tax burns. It lifts when Genesis ends — staking pays you while you wait." }
          : rate !== null && tax.driver === "recovery"
            ? { title: `Selling xTOMB at ${pct(rate)}`, why: `the recovery floor decays to ${pct(FIRE.baselineBps)} over seven hours — waiting is cheaper.` }
            : rate !== null && rate > FIRE.baselineBps
              ? { title: `Selling xTOMB at ${pct(rate)}`, why: "the tax is above baseline because the TWAP is below the reference; it falls as price recovers." }
              : { title: "Selling on an unofficial pool", why: "only the official xTOMB/USDC and xSHARE/USDC pools enforce the Fire Tax and feed the TWAP." };

  const ready = p.tranches.some((t) => trancheView(t, p.now).ready);

  if (c && c.phase !== "ended") {
    if (!p.pass) {
      return {
        headline: c.phase === "pre" ? "Genesis hasn't started. Every staking entry point needs a Genesis pass." : `Genesis day ${c.day} of ${c.totalDays}. Staking needs a Genesis pass.`,
        primary: { title: "Buy a Genesis pass", why: "Genesis 50, Pro 100 or Ultra 500 USDC — soulbound, one per wallet, same reward weighting.", cta: "Choose a pass", to: "/genesis", tone: "ember" },
        secondary: { title: "Read how Genesis works", why: "", cta: "Docs", to: "/docs#genesis", tone: "neutral" },
        avoid: { title: "Buying xTOMB to farm Genesis", why: "rewards are paid only to pass holders staking in the two Genesis pools." },
      };
    }
    if (c.phase === "pre") {
      return {
        headline: c.ultraEarly && p.pass === "ultra" ? "Ultra early access is open: stake in the standard pool before the public start." : "Genesis starts soon.",
        primary: { title: p.pass === "ultra" ? "Pre-stake in the standard pool" : "Get ready for Day 1", why: "Rewards start at the same moment and rate for every pass.", cta: "Open Genesis", to: "/genesis", tone: "ember" },
        secondary: { title: "Check the schedule", why: "", cta: "Docs", to: "/docs#genesis", tone: "neutral" },
        avoid: avoidSell,
      };
    }
    if (c.phase === "day1") {
      return {
        headline: "Day 1: the standard pool receives every Genesis emission until the LP pool opens.",
        primary: { title: "Stake in the standard pool", why: "100% of emissions today; from Day 2 the LP pool takes 75%.", cta: "Stake", to: "/genesis", tone: "ember" },
        secondary: { title: "Prepare xTOMB/USDC liquidity", why: "", cta: "Add liquidity", to: "/swap?mode=liquidity", tone: "neutral" },
        avoid: avoidSell,
      };
    }
    return {
      headline: "The xTOMB/USDC LP pool is open and carries 75% of Genesis emissions.",
      primary: { title: "Stake xTOMB/USDC LP", why: "Add liquidity to the official vault, then stake the shares. A 0.5% LP burn fee is taken once per deposit.", cta: "Open Genesis", to: "/genesis", tone: "ember" },
      secondary: { title: "Compound rewards into the LP pool", why: "", cta: "Compound", to: "/genesis", tone: "neutral" },
      avoid: avoidSell,
    };
  }

  if (ready) {
    return {
      headline: "Genesis is over. A vested installment is ready to release.",
      primary: { title: "Release your next installment", why: "Each tranche unlocks in 16 claim-gated six-hour installments; the next timer starts when you claim.", cta: "Release", to: "/genesis#vesting", tone: "ember" },
      secondary: { title: "Withdraw Genesis principal", why: "", cta: "Genesis", to: "/genesis", tone: "neutral" },
      avoid: avoidSell,
    };
  }

  if (p.market.phase === "defense") {
    return {
      headline: `Critical Defense is active. It ends after ${DEFENSE.recoveryEpochs} consecutive six-hour checkpoints above $${DEFENSE.exitAbove.toFixed(2)}.`,
      primary: { title: "Hold through the defense", why: "100% of new xSHARE sell tax is buying and burning xTOMB.", cta: "Dashboard", to: "/dashboard", tone: "amethyst" },
      secondary: { title: "Read Critical Defense", why: "", cta: "Docs", to: "/docs#defense", tone: "neutral" },
      avoid: avoidSell,
    };
  }

  return {
    headline:
      p.market.phase === "expansion"
        ? `The validated TWAP is above $${EXPANSION.gate.toFixed(2)} — the planned expansion rule would let this epoch mint up to ${pct(EXPANSION.maxPerEpochBps)} of circulating xTOMB.`
        : "Genesis is over. Farm and Masonry staking are pending their backend bindings.",
    primary: { title: "Provide official liquidity", why: "xTOMB/USDC and xSHARE/USDC vault shares are redeemable for both tokens at any time.", cta: "Add liquidity", to: "/swap?mode=liquidity", tone: "spectre" },
    secondary: { title: "See what's pending", why: "", cta: "Farm", to: "/farm", tone: "neutral" },
    avoid: avoidSell,
  };
}
