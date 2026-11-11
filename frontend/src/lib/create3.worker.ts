/// <reference lib="webworker" />
import { planBridge, planMasonrySync, type ReleaseInput } from "./create3";

/**
 * Mines hook permission bits and address patterns off the main thread with
 * the shared planner (config/create3-plan.mjs). Posts `{ searching: role }`
 * while it works, then `{ plan }` or `{ error }`.
 */
self.addEventListener("message", ({ data }: MessageEvent<ReleaseInput & { chainId: number }>) => {
  try {
    const onSearch = (role: string) => self.postMessage({ searching: role });
    const masonry = planMasonrySync(data, onSearch);
    const bridge = planBridge(data, data.chainId, "masonryShare", onSearch);
    self.postMessage({ plan: { masonry, bridge } });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "Unable to generate addresses." });
  }
});
