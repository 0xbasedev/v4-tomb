import { useRef } from "react";

import { PageHeader, SectionTitle } from "@/components/PageHeader";
import { NotDeployed, Reason } from "@/components/Status";
import { formatBps, formatDate, formatDuration, formatToken, shortAddress } from "@/lib/format";
import { useActions, useProtocol, useRoles } from "@/lib/hooks";
import { useReveal } from "@/lib/motion/useReveal";
import { NAMES } from "@/lib/protocol";

const KEYS: [string, string][] = [
  ["peg", `${NAMES.peg} token`],
  ["share", `${NAMES.share} token`],
  ["treasury", "Treasury"],
  ["masonry", `${NAMES.room} (Masonry)`],
  ["oracle", "Oracle"],
  ["hook", "PegDefenseHook"],
  ["shareBuybackHook", "ShareBuybackHook"],
  ["pairLpHook", "LpOnlyHook"],
  ["lpWrapper", `${NAMES.peg} LP wrapper`],
  ["shareLpWrapper", `${NAMES.share} LP wrapper`],
  ["pairLpWrapper", `${NAMES.peg}/${NAMES.share} LP wrapper`],
  ["genesisRewardPool", "GenesisRewardPool"],
  ["pegFarm", "PegFarm"],
  ["shareFarm", "ShareFarm"],
  ["timelock", "Timelock"],
  ["miniSwapRouter", "MiniSwapRouter"],
  ["weth", "Paired asset"],
  ["poolManager", "Uniswap V4 PoolManager"],
  ["positionManager", "Uniswap V4 PositionManager"],
  ["permit2", "Permit2"],
];

/**
 * Status — read-only. Where governance stands, whether the tax switches are
 * on, and what tax is waiting to be settled.
 *
 * The only buttons are the three calls the contracts leave open to anyone.
 * They cannot move value anywhere except the burn or the fee recipient, and
 * they are safe to call at any time: with nothing to do, they do nothing.
 */
export function Admin() {
  const root = useRef<HTMLDivElement>(null);
  const p = useProtocol();
  const act = useActions();
  const d = p.net.deployment;
  const roles = useRoles(d);
  useReveal(root, [p.deployed, roles.loaded]);
  const { tax, buyback } = p;

  const rotated = roles.rows.filter((r) => r.state === "timelock" || r.state === "treasury").length;
  const waiting = (tax.pendingBurn ?? 0n) + (tax.pendingRoute ?? 0n);
  const buybackReady = buyback.readyAt !== null && buyback.readyAt > 0 && buyback.readyAt <= p.now;

  const upkeep = [
    {
      name: "pokeTaxRate",
      title: "Advance the tax ratchet",
      body: "Samples the TWAP now, so a recovery window opens — or closes — without waiting for the next trade. It can raise the rate, never skip a window.",
      state: tax.pendingDecrease ? `Falls to ${formatBps(tax.pendingDecrease.toBps)} from ${formatDate(tax.pendingDecrease.readyAt)}` : tax.rateBps !== null && tax.targetBps !== null && tax.targetBps < tax.rateBps ? "A lower rate is possible: poke to open the window" : "No decrease pending",
      run: act.pokeTaxRate,
      hint: null as string | null,
    },
    {
      name: "settleDeferredTax",
      title: "Settle deferred tax",
      body: `Burns or routes ${NAMES.peg} tax that was parked because the pool could not pay it out during the swap.`,
      state: `${formatToken(waiting)} ${NAMES.peg} waiting · ${formatToken(tax.settleableNow)} settleable now`,
      run: act.settleDeferredTax,
      hint: p.deployed && tax.settleableNow === 0n ? "Nothing can be settled right now, so this call would do nothing." : null,
    },
    {
      name: "executeBuyback",
      title: "Execute the buyback",
      body: `Swaps the ${NAMES.share} sell tax into ${NAMES.peg} and burns it. It converts nothing if the TWAP window is too short or the price is past its limit.`,
      state: `${formatToken(buyback.pendingQuote, p.quoteDecimals)} ${p.symbols.quote} waiting · ${buyback.readyAt ? (buybackReady ? "ready" : `ready ${formatDate(buyback.readyAt)}`) : "needs a checkpoint first"}`,
      run: act.executeBuyback,
      hint: p.deployed && buyback.pendingQuote === 0n ? "Nothing is waiting, so this call would do nothing." : null,
    },
  ];

  return (
    <div ref={root}>
      <PageHeader eyebrow="Status · read-only" title="Protocol status" lede="Who holds each role, whether the tax switches are on, and what is waiting to be settled. This page cannot change a parameter: every privileged action goes through the Timelock." />

      <div className="mx-auto w-full max-w-7xl space-y-10 px-4 pb-10 md:px-8">
        {!p.deployed && <NotDeployed what="Protocol status" />}

        <section>
          <SectionTitle kicker="Switches" title="Is the tax on?" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <Switch label={`${NAMES.peg} sell tax`} source="PegDefenseHook.autoCalculateTax" on={tax.enabled} detail={tax.rateBps !== null ? `Rate now ${formatBps(tax.rateBps)} · schedule ${formatBps(tax.targetBps)}` : "No reading"} />
            <Switch label={`${NAMES.share} sell tax`} source="ShareBuybackHook.taxEnabled" on={buyback.enabled} detail="Funds the buyback and burn" />
            <div data-reveal className="panel p-5">
              <div className="label mb-2">Fee recipient</div>
              <div className="num text-[15px] text-bone">{shortAddress(tax.feeRecipient)}</div>
              <p className="mt-2 text-[12.5px] leading-relaxed text-ash">Receives {NAMES.peg} tax collected at a TWAP of {tax.burnThreshold?.toFixed(2) ?? "1.10"} or above. Below it, the tax is burned.</p>
            </div>
          </div>
        </section>

        <section>
          <SectionTitle kicker="Upkeep" title="Calls anyone can make" />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {upkeep.map((u) => (
              <div key={u.name} data-reveal className="panel flex flex-col p-5">
                <div className="mb-1 font-mono text-[11px] text-iris-hot">{u.name}()</div>
                <h3 className="font-display text-[16px] font-semibold tracking-[-0.02em] text-bone">{u.title}</h3>
                <p className="mt-2 flex-1 text-[13px] leading-relaxed text-bone-dim">{u.body}</p>
                <p className="mt-3 rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2 font-mono text-[11.5px] text-bone-dim">{p.deployed ? u.state : "—"}</p>
                <button type="button" onClick={() => u.run()} disabled={!!act.blocked || act.busy} className="btn mt-4 w-full">
                  {act.busy ? "Working…" : `Call ${u.name}`}
                </button>
                {act.blocked ? <Reason>{act.blocked}</Reason> : u.hint ? <Reason>{u.hint}</Reason> : <Reason>Permissionless. It costs gas and pays you nothing.</Reason>}
              </div>
            ))}
          </div>
        </section>

        <section>
          <SectionTitle
            kicker="Governance"
            title="Roles at the Timelock"
            right={p.deployed && roles.loaded ? <span className={`chip ${rotated === roles.rows.length ? "chip-ok" : "chip-warn"}`}>{rotated} of {roles.rows.length} behind the Timelock or Treasury</span> : undefined}
          />
          <div className="mb-4 grid grid-cols-1 gap-4 md:grid-cols-3">
            <Fact k="Timelock" v={shortAddress(roles.timelock.address)} />
            <Fact k="Timelock admin" v={shortAddress(roles.timelock.admin)} sub={roles.timelock.pendingAdmin && !/^0x0+$/.test(roles.timelock.pendingAdmin) ? `Pending: ${shortAddress(roles.timelock.pendingAdmin)}` : undefined} />
            <Fact k="Delay" v={roles.timelock.delaySeconds !== null ? formatDuration(roles.timelock.delaySeconds) : "—"} sub="Minimum 24 hours, by contract" />
          </div>
          {p.deployed ? (
            <div data-reveal className="panel overflow-x-auto p-0">
              <table className="crypt-table w-full min-w-[560px] text-[13px]">
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th>Role</th>
                    <th>Holder</th>
                    <th>Standing</th>
                  </tr>
                </thead>
                <tbody>
                  {roles.rows.map((r) => (
                    <tr key={`${r.contract}-${r.role}`}>
                      <td className="font-semibold text-bone">{r.contract}</td>
                      <td className="text-bone-dim">{r.role}</td>
                      <td className="num text-bone-dim" title={r.holder ?? undefined}>{shortAddress(r.holder)}</td>
                      <td>
                        {r.state === "timelock" ? <span className="chip chip-ok">Timelock</span> : r.state === "treasury" ? <span className="chip chip-spectre">Treasury</span> : r.state === "other" ? <span className="chip chip-warn">Not the Timelock</span> : <span className="text-ash">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p data-reveal className="rounded-2xl border border-dashed border-white/12 bg-black/20 p-5 text-[13.5px] leading-relaxed text-bone-dim">
              Once deployed, this table lists the operator, owner and trustees of every contract and marks each one that is not yet held by the Timelock.
            </p>
          )}
          <p className="mt-3 text-[12.5px] leading-relaxed text-ash">"Not the Timelock" means a single address can still change that contract's parameters without delay. The token and {NAMES.room} operators are expected to be the Treasury, which is how it mints and pays out.</p>
        </section>

        <section>
          <SectionTitle kicker="Deployment" title={`Addresses on ${p.net.network.name}`} />
          {d ? (
            <div data-reveal className="panel overflow-x-auto p-0">
              <table className="crypt-table w-full min-w-[480px] text-[13px]">
                <tbody>
                  {KEYS.map(([key, label]) => (
                    <tr key={key}>
                      <td className="text-bone-dim">{label}</td>
                      <td className="num break-all text-right text-bone">{String((d as unknown as Record<string, unknown>)[key])}</td>
                    </tr>
                  ))}
                  <tr>
                    <td className="text-bone-dim">Deploy block</td>
                    <td className="num text-right text-bone">{d.deployBlock.toString()}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          ) : (
            <p data-reveal className="rounded-2xl border border-dashed border-white/12 bg-black/20 p-5 text-[13.5px] leading-relaxed text-bone-dim">
              No addresses: <code>config/networks.json</code> has no deployment for {p.net.network.name}. When one is published there, this page — and every other — reads it without a code change.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

function Switch({ label, source, on, detail }: { label: string; source: string; on: boolean | null; detail: string }) {
  return (
    <div data-reveal className="panel p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="label">{label}</span>
        <span className={`chip ${on === null ? "" : on ? "chip-ok" : "chip-warn"}`}>{on === null ? "Unknown" : on ? "On" : "Off"}</span>
      </div>
      <div className="font-mono text-[11.5px] text-ash">{source}</div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-bone-dim">{on === null ? "Read from chain once deployed." : detail}</p>
    </div>
  );
}

function Fact({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div data-reveal className="panel p-5">
      <div className="label mb-2">{k}</div>
      <div className="num text-[15px] text-bone">{v}</div>
      {sub && <div className="mt-1 text-[12px] text-ash">{sub}</div>}
    </div>
  );
}
