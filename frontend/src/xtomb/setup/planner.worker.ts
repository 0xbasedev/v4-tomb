import * as viem from "viem";
import { create3Planner } from "../../../../config/create3-plan.mjs";
import { masonryPlanBlockers } from "../../../../config/launch-blockers.mjs";
import { bridgeInput, buildInputs, type Fields, type LaunchPlan } from "./configuration";

const planner = create3Planner(viem);
self.addEventListener("message", ({ data }: MessageEvent<{ fields: Fields; requireFuture: boolean }>) => {
  try {
    const input = buildInputs(data.fields, data.requireFuture);
    const onSearch = (role: string) => self.postMessage({ searching: role });
    const plan: LaunchPlan = {
      ...input,
      masonry: planner.planMasonry(input.release, onSearch),
      bridge: input.withBridge ? planner.planBridge(bridgeInput, input.release, onSearch) : null,
    };
    plan.blockers = masonryPlanBlockers(plan.masonry, {
      expectedChainId: plan.network.id,
      create3Address: planner.create3Address,
      infrastructure: plan.network.infrastructure,
    });
    self.postMessage({ plan });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "Unable to generate addresses." });
  }
});
