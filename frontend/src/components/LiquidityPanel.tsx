import { useState } from "react";
import { useReadContracts } from "wagmi";
import { formatUnits, parseUnits } from "viem";

import { Row } from "@/components/Modal";
import { Segmented } from "@/components/docs/kit";
import { Reason, SimBadge } from "@/components/Status";
import { TokenIcon } from "@/components/TokenIcon";
import { masonryLevelUsdcVaultAbi, masonrySquareUsdcVaultAbi } from "@/lib/abis/masonry";
import { sizeDeposit } from "@/lib/compoundPlan";
import { useActions, useProtocol } from "@/lib/hooks";
import { usd } from "@/lib/peg";
import { maskDecimalInput } from "@/lib/util/decimal";

/**
 * Official liquidity — MasonryLevelUsdcVault / MasonrySquareUsdcVault. One
 * fixed tick range per vault; one share = one unit of liquidity. Add takes
 * both tokens in the range's proportion; Remove redeems shares for both with
 * explicit output floors (the four-argument redeem). No Fire Tax on either:
 * nothing is sold.
 */
type Lp = "xTOMB-USDC" | "xSHARE-USDC";

const fmt = (n: number | null | undefined, d = 4) => (n === null || n === undefined || !isFinite(n) ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: d }));

export function LiquidityPanel() {
  const p = useProtocol();
  const actions = useActions();
  const [lp, setLp] = useState<Lp>("xTOMB-USDC");
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [amount, setAmount] = useState("");
  const asset = lp === "xTOMB-USDC" ? "xTOMB" : "xSHARE";
  const price = p.prices[asset] ?? null;
  const amt = parseFloat(amount) || 0;
  const c = p.net.deployment?.contracts;
  const vault = c ? (lp === "xTOMB-USDC" ? c.levelVault : c.squareVault) : undefined;
  const abi = lp === "xTOMB-USDC" ? masonryLevelUsdcVaultAbi : masonrySquareUsdcVaultAbi;
  const reads = useReadContracts({
    allowFailure: true,
    contracts: vault
      ? [
          { address: vault, abi, functionName: "tickLower" },
          { address: vault, abi, functionName: "tickUpper" },
          { address: vault, abi, functionName: "assetIsCurrency0" },
        ]
      : [],
    query: { enabled: !!vault },
  });

  // Sizing: Preview uses the sample in-range composition (≈ one asset-dollar + one USDC per share).
  let usdcNeeded: number | null = null;
  let shares: number | null = null;
  if (mode === "add" && amt > 0 && price) {
    if (p.sim) {
      usdcNeeded = amt * price;
      shares = (amt * price * 2) / (p.prices[lp] ?? 1);
    } else if (reads.data && reads.data.length === 3 && reads.data.every((r) => r.status === "success")) {
      const d = reads.data as readonly { result?: unknown }[];
      const sized = sizeDeposit({
        assetRaw: parseUnits(amt.toFixed(18), 18),
        spot: price,
        assetDecimals: 18,
        tickLower: Number(d[0]!.result),
        tickUpper: Number(d[1]!.result),
        assetIsCurrency0: d[2]!.result as boolean,
      });
      if (sized) {
        usdcNeeded = Number(formatUnits(sized.usdcRaw, 6));
        shares = Number(formatUnits(sized.shares, 18));
      }
    }
  }
  const lpPrice = p.prices[lp] ?? null;
  const redeemValue = mode === "remove" && amt > 0 && lpPrice ? amt * lpPrice : null;
  const bal = (id: string) => p.balances[id as keyof typeof p.balances] ?? null;
  const short =
    mode === "add"
      ? (bal(asset) !== null && amt > (bal(asset) as number)) || (usdcNeeded !== null && bal("USDC") !== null && usdcNeeded > (bal("USDC") as number))
      : bal(lp) !== null && amt > (bal(lp) as number);
  const reason = !p.account
    ? "Connect a wallet."
    : !p.sim && !p.net.canTransact
      ? p.net.reason
      : short
        ? "Not enough balance for this amount."
        : mode === "add" && amt > 0 && shares === null
          ? "The price is outside the vault's range or not available — deposits there are one-sided."
          : null;

  return (
    <div data-reveal className="panel panel-raised w-full p-4 md:p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2">
          <span className="font-display text-[15px] font-semibold text-bone">Liquidity</span>
          {p.sim && <SimBadge />}
        </div>
        <Segmented options={[{ id: "add", label: "Add" }, { id: "remove", label: "Remove" }]} value={mode} onChange={(m) => (setMode(m), setAmount(""))} />
      </div>
      <div className="mb-3 grid grid-cols-2 gap-2">
        {(["xTOMB-USDC", "xSHARE-USDC"] as Lp[]).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setLp(id)}
            className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-left text-[12.5px] ${lp === id ? "border-ember/50 bg-ember/[0.07] text-bone" : "border-white/[0.07] text-bone-dim hover:border-white/20"}`}
          >
            <TokenIcon symbol={id} size={22} />
            {id === "xTOMB-USDC" ? "xTOMB/USDC" : "xSHARE/USDC"}
          </button>
        ))}
      </div>
      <div className="rounded-2xl bg-black/35 p-4">
        <div className="mb-2 flex items-center justify-between">
          <span className="label">{mode === "add" ? `${asset} in` : "Shares to redeem"}</span>
          <button type="button" onClick={() => setAmount(String(bal(mode === "add" ? asset : lp) ?? ""))} className="font-mono text-[11px] text-ash hover:text-ember-hot">
            Bal {fmt(bal(mode === "add" ? asset : lp))} · MAX
          </button>
        </div>
        <input
          aria-label={mode === "add" ? `Amount of ${asset} to add` : "Shares to redeem"}
          inputMode="decimal"
          placeholder="0"
          value={amount}
          onChange={(e) => setAmount(maskDecimalInput(e.target.value))}
          className="num w-full bg-transparent text-[28px] leading-none text-bone outline-none"
        />
      </div>
      <dl className="mt-4 space-y-2 px-1 text-[13px]">
        {mode === "add" ? (
          <>
            <Row k="USDC alongside" v={usdcNeeded !== null ? `${fmt(usdcNeeded, 2)} USDC` : "—"} sub="in the vault range's proportion" />
            <Row k="Vault shares out" v={shares !== null ? fmt(shares) : "—"} sub={p.sim ? "simulated" : "rounded down 0.5% so the max bounds hold"} />
          </>
        ) : (
          <>
            <Row k="You receive" v={redeemValue !== null ? `≈ ${usd(redeemValue / 2)} ${asset} + ${usd(redeemValue / 2)} USDC` : "—"} sub={p.sim ? "simulated composition" : "exact amounts from the redeem simulation"} />
            <Row k="Floors" v="0.5% under the simulated output" sub="four-argument redeem: minimum asset and USDC out" />
          </>
        )}
        <Row k="Fire Tax" v="none" sub="adding or redeeming liquidity sells nothing" tone="text-ok" />
      </dl>
      <button
        type="button"
        className="btn btn-spectre mt-4 h-12 w-full"
        disabled={!(amt > 0) || !!reason || actions.busy}
        onClick={() => {
          if (mode === "add" && usdcNeeded !== null && shares !== null) actions.addLiquidity(lp, amt, usdcNeeded, shares, () => setAmount(""));
          else if (mode === "remove") void actions.redeem(lp, amt, 50, () => setAmount(""));
        }}
      >
        {mode === "add" ? "Add liquidity" : "Redeem for both tokens"}
        {p.sim ? " (simulated)" : ""}
      </button>
      {reason && amt > 0 && <Reason>{reason}</Reason>}
    </div>
  );
}
