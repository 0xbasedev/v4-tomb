import { formatBps } from "@/lib/format";
import { useProtocol, type ProtocolState } from "@/lib/hooks";
import { NAMES, TAX } from "@/lib/protocol";

export interface Move {
  title: string;
  why: string;
  cta: string;
  to: string;
}
export interface NextMove {
  headline: string;
  /** The one thing worth doing now. */
  primary: Move;
  /** A reasonable alternative, shown quietly. */
  secondary: Move;
  /** The thing that costs you, named rather than hidden. */
  avoid: { title: string; why: string };
}

/**
 * The interface's opinion, derived from live state only. Each branch names one
 * recommended action, one alternative and one thing to avoid — with the reason.
 */
export function nextMove(p: ProtocolState): NextMove {
  const { peg, share, room } = { ...NAMES };
  const sellTax = p.tax.enabled === false ? 0 : (p.tax.rateBps ?? TAX.maxBps);
  const avoidSell = {
    title: `Selling ${peg} at a ${formatBps(sellTax)} tax`,
    why:
      sellTax >= TAX.maxBps
        ? `The sell tax is at its 12% cap. It only eases to 6% once the TWAP holds at 1.12 or above, and a cut takes 7 hours to land.`
        : `Every ${peg} sell pays ${formatBps(sellTax)} of the amount sold. The swap screen shows the exact loss before you sign.`,
  };

  if (!p.deployed) {
    return {
      headline: "Nothing is deployed on this network yet, so there is nothing to act on.",
      primary: { title: "Read how the system works", why: "Emissions, the sell tax, the three pools and the lockups — with the numbers from the contracts.", cta: "Open the docs", to: "/docs" },
      secondary: { title: "See the protocol status", why: "Where each contract and role would appear once deployed.", cta: "Open status", to: "/admin" },
      avoid: { title: "Trusting numbers before launch", why: "This interface shows no prices or balances until a deployment exists. Anything else claiming live figures is not this protocol." },
    };
  }

  const g = p.farms.genesis;
  if (g.phase === "live" || g.phase === "upcoming") {
    return {
      headline: g.phase === "live" ? `Genesis is running: 24 hours of ${peg} emissions to depositors.` : "Genesis opens soon. It runs for 24 hours, before the first epoch.",
      primary: { title: g.phase === "live" ? "Deposit into Genesis" : "Get ready for Genesis", why: `Genesis pays ${peg} pro-rata to deposits for its 24-hour window. Your deposit stays yours and can be withdrawn at any time.`, cta: "Open Genesis", to: "/genesis" },
      secondary: { title: "Learn the sell tax first", why: "Know what selling costs before you earn anything.", cta: "Open swap", to: "/swap" },
      avoid: avoidSell,
    };
  }

  const staked = (p.masonry.staked ?? 0n) > 0n;
  const earned = (p.masonry.earned ?? 0n) > 0n;
  if (earned && p.masonry.canClaim) {
    return {
      headline: `You have ${peg} waiting in ${room}.`,
      primary: { title: `Claim your ${peg}`, why: `The reward lockup has passed. Claiming restarts both lockups, so claim when you also do not plan to withdraw for ${p.masonry.withdrawLockupEpochs} epochs.`, cta: `Open ${room}`, to: "/masonry" },
      secondary: { title: "Add it back as liquidity", why: `Pair it and stake the wrapped position for ${share}.`, cta: "Open farm", to: "/farm" },
      avoid: avoidSell,
    };
  }
  if (p.market.phase === "expansion" && !staked) {
    return {
      headline: `TWAP is above the ${p.market.ceiling.toFixed(2)} ceiling: the next epoch mints ${peg} to ${room} stakers.`,
      primary: { title: `Stake in ${room}`, why: `Expansion is paid only to stakers. Deposits are untaxed; withdrawals unlock after ${p.masonry.withdrawLockupEpochs} epochs.`, cta: `Open ${room}`, to: "/masonry" },
      secondary: { title: `Farm ${share}`, why: "Wrap a liquidity position and stake it.", cta: "Open farm", to: "/farm" },
      avoid: avoidSell,
    };
  }
  return {
    headline:
      p.market.phase === "expansion"
        ? `Expansion is on. Your ${room} stake earns each epoch.`
        : `TWAP is at or below the ${p.market.ceiling.toFixed(2)} ceiling: no ${peg} is minted this epoch.`,
    primary: { title: `Farm ${share} with liquidity`, why: `The farms pay whether or not the Treasury is expanding. Mint a full-range position, wrap it, stake it.`, cta: "Open farm", to: "/farm" },
    secondary: staked
      ? { title: `Check your ${room} lockups`, why: "See when you can claim and withdraw.", cta: `Open ${room}`, to: "/masonry" }
      : { title: `Stake in ${room}`, why: "Be in position before the next expansion.", cta: `Open ${room}`, to: "/masonry" },
    avoid: avoidSell,
  };
}

export const useNextMove = () => nextMove(useProtocol());
