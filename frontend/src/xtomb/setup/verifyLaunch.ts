import { createPublicClient, http, keccak256 } from "viem";
import { factory, factoryCodeHash } from "../../../../config/create3-plan.mjs";
import type { LaunchPlan } from "./configuration";

export type Verification = {
  chainId: number;
  block: string;
  checks: Array<{ label: string; status: "present" | "missing" | "factory" | "wrong-code" }>;
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
  return { chainId, block: blockNumber.toString(), checks };
}
