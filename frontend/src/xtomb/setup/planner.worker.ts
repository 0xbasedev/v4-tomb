import * as viem from "viem";
import { create3Planner } from "../../../../config/create3-plan.mjs";
import { bridgeInput, buildInputs, type Fields, type LaunchPlan } from "./configuration";

const planner = create3Planner(viem);
self.addEventListener("message", ({ data }: MessageEvent<{ fields: Fields; requireFuture: boolean }>) => {
  try {
    const input = buildInputs(data.fields, data.requireFuture);
    const plan: LaunchPlan = {
      ...input,
      masonry: planner.planMasonry(input.release),
      bridge: input.withBridge ? planner.planBridge(bridgeInput, input.release) : null,
    };
    self.postMessage({ plan });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "Unable to generate addresses." });
  }
});
