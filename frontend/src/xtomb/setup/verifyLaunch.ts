import { createPublicClient, erc20Abi, http, keccak256, parseAbi } from "viem";
import officialRegistry from "../../../../config/official-infrastructure.json";
import { onchainBlockers, rangeBindings } from "../../../../config/launch-blockers.mjs";
import { factory, factoryCodeHash } from "../../../../config/create3-plan.mjs";
import type { LaunchPlan } from "./configuration";

export type Verification = {
  chainId: number;
  block: string;
  checks: Array<{ label: string; status: "present" | "missing" | "factory" | "wrong-code" }>;
  /** Hard blockers: missing code, unbound range managers, wrong peg-token decimals. */
  blockers: string[];
};

export async function verifyLaunch(plan: LaunchPlan, expectedChain: number, signal: AbortSignal): Promise<Verification> {
  const home = expectedChain === plan.network.id;
  const bridge = plan.bridge?.networks.find(({ id }) => id === expectedChain);
  const rpcUrl = home ? plan.network.rpcUrl : bridge?.rpcUrl;
  if (!rpcUrl) throw new Error("Select a network in this release.");
  const client = createPublicClient({ transport: http(rpcUrl, { fetchOptions: { signal }, retryCount: 0, timeout: 10_000 }) });
  const chainId = await client.getChainId();
  if (chainId !== expectedChain) throw new Error(`RPC returned chain ${chainId}. The release is configured for chain ${expectedChain}.`);
  const blockNumber = await client.getBlockNumber();
  const targets: Array<readonly [string, `0x${string}`]> = [["CreateX", factory]];
  if (home) targets.push(...Object.entries(plan.network.infrastructure), ...Object.entries(plan.masonry.addresses));
  if (bridge) targets.push(
    ["Hyperlane Mailbox", bridge.mailbox], ["Bridge verifier", bridge.bridgeIsm], ["xSHARE bridge", bridge.bridge],
    ...(home ? [] : [["Wrapped xSHARE", bridge.token] as const]),
  );
  const checks: Verification["checks"] = [];
  for (let index = 0; index < targets.length; index += 4) {
    const batch = await Promise.all(targets.slice(index, index + 4).map(async ([label, address]) => {
      const code = await client.getCode({ address, blockNumber });
      const status = !code || code === "0x" ? "missing"
        : label !== "CreateX" ? "present" : keccak256(code) === factoryCodeHash ? "factory" : "wrong-code";
      return { label, status } as const;
    }));
    checks.push(...batch);
  }
  const blockers: string[] = [];
  if (home) {
    const code = Object.fromEntries(checks.filter((c) => c.label !== "CreateX").map((c) => [c.label, c.status === "missing" ? "0x" : "1"]));
    const rangeManagerOf: Record<string, string> = {};
    for (const hook of Object.values(rangeBindings)) {
      const address = plan.masonry.addresses[hook] as `0x${string}` | undefined;
      if (!address) continue;
      try {
        rangeManagerOf[hook] = await client.readContract({ address, abi: parseAbi(["function rangeManager() view returns (address)"]), functionName: "rangeManager", blockNumber });
      } catch { /* unbound or no code: reported below */ }
    }
    const peg = (plan.network.infrastructure as Record<string, string>).usdc as `0x${string}` | undefined;
    let decimalsRead: number | undefined;
    if (peg) {
      try { decimalsRead = await client.readContract({ address: peg, abi: erc20Abi, functionName: "decimals", blockNumber }); } catch { decimalsRead = undefined; }
    }
    const expected = (officialRegistry.chains as Array<{ id: number; pegTokenDecimals?: number }>).find((c) => c.id === plan.network.id)?.pegTokenDecimals;
    if (expected === undefined) blockers.push("peg token decimals are not listed for this chain in official-infrastructure.json");
    if (peg && decimalsRead === undefined) blockers.push("could not read peg token decimals");
    blockers.push(...onchainBlockers({ code, rangeManagerOf, plan: plan.masonry, decimalsRead, decimalsExpected: expected }));
  }
  if (checks.some((c) => c.status === "wrong-code")) blockers.push("CREATE3 factory runtime is not CreateX");
  return { chainId, block: blockNumber.toString(), checks, blockers };
}
