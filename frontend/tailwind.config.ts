import type { Config } from "tailwindcss";

/**
 * xTomb — "Obsidian Crypt" design tokens.
 *
 * Ground is volcanic glass (near-black with a cold blue cast). Heat is the
 * signal: xTOMB is molten ember, xSHARE is cold spectral cyan, xBOND is
 * amethyst. Status colours (ok / warn / bad) are reserved for state — never
 * decoration — so the eye learns that colour means "act" or "careful".
 *
 * Every colour is a flat hex so Tailwind's /opacity modifiers work.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ---- Ground (obsidian) ----
        void: "#050507",
        basalt: "#0b0c10",
        "basalt-2": "#111319",
        "basalt-3": "#181b23",
        seam: "#23262f",

        // ---- Ink ----
        bone: "#ece8df",
        "bone-dim": "#b9b5ac",
        ash: "#7c7a74",
        "ash-dim": "#4a4945",

        // ---- Heat: xTOMB ----
        ember: "#ff6a2b",
        "ember-hot": "#ffb547",
        "ember-deep": "#c2410c",
        magma: "#ff3d1f",

        // ---- Cold: xSHARE ----
        spectre: "#3ee7ff",
        "spectre-deep": "#2a8cff",

        // ---- Seal: xBOND ----
        amethyst: "#b48cff",
        "amethyst-deep": "#7c4dff",

        // ---- State ----
        ok: "#34e3a0",
        warn: "#ffc24b",
        bad: "#ff4d6a",
      },
      fontFamily: {
        display: ['"Unbounded Variable"', '"Unbounded"', "system-ui", "sans-serif"],
        sans: ['"Inter Variable"', '"Inter"', "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        hero: ["clamp(54px, 8.4vw, 128px)", { lineHeight: "0.86", letterSpacing: "-0.04em", fontWeight: "700" }],
        section: ["clamp(30px, 4.2vw, 52px)", { lineHeight: "1.02", letterSpacing: "-0.02em", fontWeight: "600" }],
        subhead: ["clamp(17px, 1.6vw, 21px)", { lineHeight: "1.5" }],
        label: ["11px", { lineHeight: "1.2", letterSpacing: "0.16em", fontWeight: "500" }],
      },
      borderRadius: {
        shard: "18px",
      },
      boxShadow: {
        panel: "inset 0 1px 0 0 rgba(255,255,255,0.05), 0 24px 48px -24px rgba(0,0,0,0.8)",
        ember: "0 0 0 1px rgba(255,106,43,0.5), 0 10px 40px -10px rgba(255,106,43,0.55)",
        spectre: "0 0 0 1px rgba(62,231,255,0.45), 0 10px 40px -10px rgba(62,231,255,0.45)",
        amethyst: "0 0 0 1px rgba(180,140,255,0.45), 0 10px 40px -10px rgba(180,140,255,0.45)",
      },
      keyframes: {
        "ember-flow": {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
        },
        breathe: {
          "0%, 100%": { opacity: "0.55" },
          "50%": { opacity: "1" },
        },
        "spin-slow": {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "ember-flow": "ember-flow 6s ease-in-out infinite",
        breathe: "breathe 2.4s ease-in-out infinite",
        "spin-slow": "spin-slow 90s linear infinite",
        "spin-slower": "spin-slow 160s linear infinite reverse",
        shimmer: "shimmer 1.6s linear infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
