import { useEffect, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { getAddress, isAddress, type Address, type Hex } from "viem";

import { ChainBadge } from "@/components/ChainBadge";
import { PlannedBadge, Reason } from "@/components/Status";
import {
  BRIDGE,
  BRIDGE_DOMAINS,
  bridgeNetwork,
  bridgeNetworkStatus,
  HOOK_MASK,
  MASONRY_HOOK_FLAGS,
  MASONRY_ROLES,
  planBridge,
  planMasonry,
  randomReleaseId,
  releaseProblems,
  ROLE_LABEL,
  saveRelease,
  type BridgePlan,
  type MasonryPlan,
} from "@/lib/create3";
import { EASE, gsap, prefersReducedMotion, useGSAP } from "@/lib/motion";

/**
 * Wizard step 4 — the CREATE3 release plan. The deployment signer and a
 * release ID fix every project address before anything is deployed: the 20
 * Masonry components (two hooks mined for their v4 permission bits), the
 * xSHARE bridge and Bridged xSHARE. All of it is a prediction; routes stay
 * disabled until a reviewed deployment is published.
 */

export interface ReleaseState {
  deployer: string;
  releaseId: string;
  /** Satellite caps in whole xSHARE, by chain ID. */
  caps: Record<number, string>;
  operators: Record<number, { owner: string; ism: string }>;
}

export const emptyRelease = (): ReleaseState => ({ deployer: "", releaseId: "", caps: {}, operators: {} });

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const toBaseUnits = (whole: string) => (/^[1-9]\d{0,59}$/.test(whole) ? `${whole}${"0".repeat(18)}` : null);

/** The release JSON in config/create3-release.template.json's shape. */
export function releaseJson(r: ReleaseState, chainId: number) {
  const satellites = BRIDGE_DOMAINS.filter((id) => id !== chainId);
  return {
    releaseId: r.releaseId || null,
    deployer: r.deployer && isAddress(r.deployer, { strict: false }) ? getAddress(r.deployer) : r.deployer || null,
    canonicalDomain: chainId,
    canonicalTokenRole: "masonryShare",
    routeCaps: Object.fromEntries(satellites.flatMap((id) => (toBaseUnits(r.caps[id] ?? "") ? [[id, toBaseUnits(r.caps[id]!)]] : []))),
    bridgeOperators: Object.fromEntries(
      BRIDGE_DOMAINS.flatMap((id) => {
        const o = r.operators[id];
        return o && isAddress(o.owner, { strict: false }) && isAddress(o.ism, { strict: false }) ? [[id, { owner: getAddress(o.owner), ism: getAddress(o.ism) }]] : [];
      }),
    ),
    masonryInitCodeHashes: {},
  };
}

/** What's still missing for the repository's bridge planner to accept this release. */
export function bridgeInputGaps(r: ReleaseState, chainId: number): string[] {
  if (!BRIDGE_DOMAINS.includes(chainId)) return [];
  const j = releaseJson(r, chainId);
  const out: string[] = [];
  const caps = BRIDGE_DOMAINS.filter((id) => id !== chainId && !j.routeCaps[id]);
  const ops = BRIDGE_DOMAINS.filter((id) => !j.bridgeOperators[id]);
  if (caps.length) out.push(`route caps for ${caps.map((id) => bridgeNetwork(id)!.name).join(", ")}`);
  if (ops.length) out.push(`approved owner and ISM for ${ops.map((id) => bridgeNetwork(id)!.name).join(", ")}`);
  return out;
}

export function ReleaseStep({
  chainId,
  chainName,
  release,
  setRelease,
  plan,
  setPlan,
}: {
  chainId: number;
  chainName: string;
  release: ReleaseState;
  setRelease: (r: ReleaseState) => void;
  plan: MasonryPlan | null;
  setPlan: (p: MasonryPlan | null) => void;
}) {
  const { address } = useAccount();
  const root = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [mining, setMining] = useState<{ role: string; tried: number } | null>(null);
  const problems = releaseProblems(release);
  const valid = problems.length === 0;
  const bridge: BridgePlan | null = valid ? planBridge({ releaseId: release.releaseId as Hex, deployer: release.deployer as Address }, chainId) : null;
  const bridgeHome = BRIDGE_DOMAINS.includes(chainId);
  const gaps = bridgeInputGaps(release, chainId);

  // Predict whenever the inputs settle. Mining yields to the UI and is
  // cancelled if the signer, release ID or chain changes mid-search.
  useEffect(() => {
    if (!valid) {
      setPlan(null);
      return;
    }
    if (plan && plan.releaseId === release.releaseId && plan.deployer.toLowerCase() === release.deployer.toLowerCase() && plan.chainId === chainId) return;
    const ctl = new AbortController();
    const t = window.setTimeout(async () => {
      setPlan(null);
      try {
        const p = await planMasonry({ releaseId: release.releaseId as Hex, deployer: release.deployer as Address, chainId }, (role, tried) => setMining({ role, tried }), ctl.signal);
        if (!ctl.signal.aborted) {
          setPlan(p);
          saveRelease({ releaseId: p.releaseId, deployer: p.deployer, canonicalDomain: chainId, canonicalTokenRole: "masonryShare", savedAt: Date.now() });
        }
      } catch {
        /* aborted */
      } finally {
        if (!ctl.signal.aborted) setMining(null);
      }
    }, 350);
    return () => (ctl.abort(), window.clearTimeout(t));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [release.releaseId, release.deployer, chainId, valid]);

  // A search usually ends in tens of thousands of tries; the bar eases toward
  // the expected count instead of pretending to know the end.
  useEffect(() => {
    if (!bar.current || !mining) return;
    const expected = 16_384;
    const done = mining.role === "masonryShareTaxHook" ? 0.5 : 0;
    const frac = done + 0.5 * (1 - Math.exp(-mining.tried / expected));
    gsap.to(bar.current, { scaleX: Math.min(0.97, frac), duration: 0.3, ease: "power2.out" });
  }, [mining]);

  useGSAP(
    () => {
      if (!plan || prefersReducedMotion()) return;
      gsap.from(".rel-row", { y: 8, autoAlpha: 0, duration: 0.35, stagger: 0.018, ease: EASE.rise });
    },
    { scope: root, dependencies: [plan?.releaseId, plan?.deployer, plan?.chainId] },
  );

  const set = (patch: Partial<ReleaseState>) => setRelease({ ...release, ...patch });

  return (
    <section ref={root} data-reveal className="space-y-5">
      <div className="panel p-5 md:p-6">
        <h2 className="font-display text-lg font-semibold text-bone">4 · Release plan</h2>
        <p className="mt-1 text-[13px] text-bone-dim">
          CreateX CREATE3: the deployment signer and release ID fix every project address before deployment — the same on each chain where the canonical factory exists. Home chain:{" "}
          <span className="text-bone">{chainName}</span>.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-[12.5px]">
            <span className="flex items-center justify-between text-ash">
              Deployment signer
              {address && (
                <button type="button" className="font-mono text-[11px] text-ember-hot hover:underline" onClick={() => set({ deployer: address })}>
                  use connected wallet
                </button>
              )}
            </span>
            <input value={release.deployer} onChange={(e) => set({ deployer: e.target.value.trim() })} placeholder="0x… the account that broadcasts" aria-label="Deployment signer" className="well px-2 py-1.5 font-mono text-bone" spellCheck={false} />
            <span className="text-[10.5px] text-ash-dim">Must be the actual broadcasting account — CreateX guards the salt with it.</span>
          </label>
          <label className="flex flex-col gap-1 text-[12.5px]">
            <span className="flex items-center justify-between text-ash">
              Release ID
              <button type="button" className="font-mono text-[11px] text-ember-hot hover:underline" onClick={() => set({ releaseId: randomReleaseId() })}>
                generate
              </button>
            </span>
            <input value={release.releaseId} onChange={(e) => set({ releaseId: e.target.value.trim() })} placeholder="0x… 32 bytes" aria-label="Release ID" className="well px-2 py-1.5 font-mono text-[11.5px] text-bone" spellCheck={false} />
            <span className="text-[10.5px] text-ash-dim">Keep it fixed through deployment and publication. A different configuration needs a new ID.</span>
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 font-mono text-[11px] text-ash">
          <span className="rounded-lg border border-white/[0.07] px-2 py-1">canonical token role · masonryShare (modern launch)</span>
          <span className="rounded-lg border border-white/[0.07] px-2 py-1">factory · CreateX 0xba5E…a5Ed</span>
        </div>
        {!valid && (release.deployer || release.releaseId) && (
          <ul className="mt-3 space-y-1 text-[12px] text-warn" role="status">
            {problems.map((x) => (
              <li key={x}>• {x}</li>
            ))}
          </ul>
        )}
        {mining && (
          <div className="mt-4" role="status" aria-live="polite">
            <div className="mb-1 flex justify-between font-mono text-[11px] text-ash">
              <span>Mining {ROLE_LABEL[mining.role as keyof typeof ROLE_LABEL]} for permission bits 0x35c8…</span>
              <span>{mining.tried.toLocaleString()} tried</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
              <div ref={bar} className="h-full origin-left rounded-full bg-gradient-to-r from-ember to-ember-hot" style={{ transform: "scaleX(0)" }} />
            </div>
          </div>
        )}
      </div>

      {plan && (
        <div className="panel p-5 md:p-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="label">Predicted · Masonry components</span>
            <PlannedBadge label="Prediction · not deployed" />
          </div>
          <ul className="grid grid-cols-1 gap-x-6 sm:grid-cols-2" data-testid="predicted-masonry">
            {MASONRY_ROLES.map((role) => (
              <AddressRow
                key={role}
                label={ROLE_LABEL[role]}
                role={role}
                address={plan.addresses[role]}
                note={role in plan.hookNonces ? `nonce ${plan.hookNonces[role]} · flags ${(BigInt(plan.addresses[role]) & HOOK_MASK) === MASONRY_HOOK_FLAGS ? "0x35c8 ✓" : "✕"}` : undefined}
              />
            ))}
          </ul>
          <Reason>
            Each component's reviewed creation bytecode hash goes into <span className="font-mono">masonryInitCodeHashes</span> before its deploy; the component script checks hash, expected address and chain.
          </Reason>
        </div>
      )}

      <div className="panel p-5 md:p-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="label">xSHARE bridge · Hyperlane</span>
          <PlannedBadge label="Routes disabled" />
        </div>
        {!bridgeHome ? (
          <p className="text-[13px] text-bone-dim">
            {chainName} isn't one of the five bridge networks, so this release can't be the bridge home. The bridge connects {BRIDGE.networks.map((n) => n.name).join(", ")}; pick one of them as the home chain to plan it.
          </p>
        ) : !bridge ? (
          <p className="text-[13px] text-bone-dim">Enter the signer and release ID to predict the bridge and Bridged xSHARE addresses.</p>
        ) : (
          <>
            <ul className="grid grid-cols-1 gap-x-6 sm:grid-cols-2" data-testid="predicted-bridge">
              <AddressRow label={ROLE_LABEL.xshareBridge} role="xshareBridge" address={bridge.bridge} />
              <AddressRow label={ROLE_LABEL.bridgedShare} role="bridgedShare" address={bridge.bridgedShare} />
            </ul>
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-5">
              {BRIDGE.networks.map((n) => {
                const home = n.id === chainId;
                return (
                  <div key={n.id} className={`rel-row rounded-xl border p-2.5 ${home ? "border-spectre/40 bg-spectre/[0.05]" : "border-white/[0.06] bg-black/20"}`}>
                    <div className="flex items-center gap-2">
                      <ChainBadge id={n.id} name={n.name} size={20} lit={home} />
                      <span className="truncate text-[12px] font-semibold text-bone">{n.name}</span>
                    </div>
                    <div className="mt-1 font-mono text-[10px] text-ash">{home ? "home · original xSHARE" : "Bridged xSHARE"}</div>
                    <div className="font-mono text-[10.5px] text-bone-dim">{short(bridge.tokens[n.id]!)}</div>
                    <div className="mt-1 text-[10.5px] text-warn">{bridgeNetworkStatus(n)}</div>
                  </div>
                );
              })}
            </div>
            <details className="mt-4 rounded-xl border border-white/[0.06] bg-black/20 p-3">
              <summary className="cursor-pointer text-[13px] font-semibold text-bone">Bridge release inputs {gaps.length ? <span className="ml-1 text-[11px] font-normal text-warn">· incomplete</span> : <span className="ml-1 text-[11px] font-normal text-ok">· complete</span>}</summary>
              <p className="mt-2 text-[12px] text-bone-dim">
                The repository's bridge planner needs a cap for each satellite route and an approved owner and ISM on every network. The checked-in default ISMs are observed reference data, not an approval.
              </p>
              <div className="mt-3 grid grid-cols-1 gap-3">
                {BRIDGE.networks.map((n) => {
                  const home = n.id === chainId;
                  const op = release.operators[n.id] ?? { owner: "", ism: "" };
                  return (
                    <div key={n.id} className="grid grid-cols-1 gap-2 rounded-lg border border-white/[0.05] p-2.5 sm:grid-cols-[150px_1fr_1fr_140px] sm:items-end">
                      <div className="text-[12.5px] text-bone">
                        {n.name}
                        <div className="font-mono text-[10px] text-ash">{home ? "home" : `route cap from ${chainName}`}</div>
                      </div>
                      <input aria-label={`${n.name} bridge owner`} placeholder="owner 0x…" value={op.owner} onChange={(e) => set({ operators: { ...release.operators, [n.id]: { ...op, owner: e.target.value.trim() } } })} className="well px-2 py-1.5 font-mono text-[11px] text-bone" spellCheck={false} />
                      <input aria-label={`${n.name} ISM`} placeholder="ISM 0x…" value={op.ism} onChange={(e) => set({ operators: { ...release.operators, [n.id]: { ...op, ism: e.target.value.trim() } } })} className="well px-2 py-1.5 font-mono text-[11px] text-bone" spellCheck={false} />
                      {home ? (
                        <span className="font-mono text-[10.5px] text-ash-dim">no cap at home</span>
                      ) : (
                        <input aria-label={`${n.name} route cap`} placeholder="cap · whole xSHARE" inputMode="numeric" value={release.caps[n.id] ?? ""} onChange={(e) => set({ caps: { ...release.caps, [n.id]: e.target.value.replace(/[^0-9]/g, "") } })} className="well px-2 py-1.5 font-mono text-[11px] text-bone" />
                      )}
                    </div>
                  );
                })}
              </div>
              {gaps.length > 0 && <Reason tone="warn">Still needed: {gaps.join("; ")}.</Reason>}
            </details>
          </>
        )}
      </div>

      <div className="panel p-5 md:p-6">
        <div className="label mb-2">Regenerate and verify from the repository</div>
        <pre className="overflow-x-auto rounded-xl bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-bone-dim">{`node scripts/create3.mjs masonry - config/release.json config/masonry.release.json
node scripts/create3.mjs bridge config/xshare-bridge.json config/release.json config/xshare-bridge.release.json`}</pre>
        <Reason>The planner is offline and deterministic; this page runs the same algorithm. Deploy scripts check every planned address before broadcasting.</Reason>
      </div>
    </section>
  );
}

function AddressRow({ label, role, address, note }: { label: string; role: string; address: Address; note?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <li className="rel-row flex items-center justify-between gap-3 border-b border-white/[0.04] py-1.5">
      <span className="min-w-0">
        <span className="block truncate text-[12.5px] text-bone-dim">{label}</span>
        <span className="block font-mono text-[10px] text-ash-dim">
          {role}
          {note ? ` · ${note}` : ""}
        </span>
      </span>
      <button
        type="button"
        title={address}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(address);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          } catch {
            /* clipboard blocked; the full address is in the title */
          }
        }}
        className="shrink-0 rounded-lg border border-white/[0.07] px-2 py-1 font-mono text-[11px] text-bone hover:border-white/20"
      >
        {copied ? "copied" : short(address)}
      </button>
    </li>
  );
}
