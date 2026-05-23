/**
 * Decimal input masking. Used by all three forms (ActionPanel, BondForm, SwapCard)
 * to reject characters that would corrupt the parseUnits call downstream.
 *
 * Allowed: digits 0-9, at most one '.'. Empty string passes through.
 * Leading/trailing whitespace stripped. Multiple dots → keep only the first.
 *
 * Does NOT enforce decimals count (parseUnits handles that based on the token).
 * Does NOT enforce a maximum — that's the caller's job via the disabled state.
 */
export function maskDecimalInput(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";

  // Strip non-[digit, dot] characters.
  let filtered = "";
  let seenDot = false;
  for (const ch of trimmed) {
    if (ch >= "0" && ch <= "9") {
      filtered += ch;
    } else if (ch === "." && !seenDot) {
      filtered += ch;
      seenDot = true;
    }
    // anything else → drop
  }

  // Strip leading zeros except for "0" and "0.something".
  if (filtered.length > 1 && filtered[0] === "0" && filtered[1] !== ".") {
    filtered = filtered.replace(/^0+/, "");
    if (filtered === "" || filtered[0] === ".") filtered = "0" + filtered;
  }

  return filtered;
}

/**
 * Parse a masked decimal string into a non-negative bigint of `decimals` precision.
 * Returns 0n for empty / invalid input. Truncates extra decimal places rather than
 * rounding — wei-precision math should be lossless above the truncation point.
 */
export function decimalToBigInt(masked: string, decimals: number): bigint {
  if (!masked || masked === ".") return 0n;
  const [intPart = "0", fracPartRaw = ""] = masked.split(".");
  const fracPart = (fracPartRaw + "0".repeat(decimals)).slice(0, decimals);
  try {
    return BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(fracPart || "0");
  } catch {
    return 0n;
  }
}
