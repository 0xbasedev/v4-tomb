#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateLiteRelease, exportPublicEnv } from "./release.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = process.argv[2] || path.join(here, "release.template.json");
const outputFile = process.argv[3] || path.join(here, "..", ".env.local");
const validateOnly = process.argv.includes("--validate-only");

try {
  const plan = JSON.parse(fs.readFileSync(configFile, "utf8"));
  const result = validateLiteRelease(plan);
  console.log("Validated xTomb Lite release:", result);
  if (!validateOnly) {
    const env = exportPublicEnv(plan);
    const data = Object.entries(env).map(([name, value]) => `${name}=${value}`).join("\n") + "\n";
    fs.writeFileSync(outputFile, data, { mode: 0o600, flag: "wx" });
    console.log("Wrote non-secret deployment configuration:", outputFile);
    console.log("No wallet keys were exported. Use your own local encrypted keystore.");
  }
} catch (error) {
  console.error("RELEASE BLOCKED:", error.message);
  process.exitCode = 1;
}
