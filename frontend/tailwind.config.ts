import type { Config } from "tailwindcss";

/**
 * Tailwind names for the theme tokens defined in src/styles/index.css (:root).
 * Colours are declared there, once; this file only maps names onto them so the
 * /opacity modifiers work. Do not add a raw accent hex here.
 *
 *   Ground  void · basalt · seam        near-black, cold cast
 *   Ink     bone · ash                  cool off-white
 *   Accent  violet → indigo → blue      (iris-* = violet ramp, spectre = blue ramp)
 *   State   ok · warn · bad
 */
const v = (name: string) => `rgb(var(--${name}-rgb) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        void: v("void"),
        basalt: v("basalt"),
        "basalt-2": v("basalt-2"),
        "basalt-3": v("basalt-3"),
        seam: v("seam"),

        bone: v("bone"),
        "bone-dim": v("bone-dim"),
        ash: v("ash"),
        "ash-dim": v("ash-dim"),

        violet: v("violet"),
        indigo: v("indigo"),
        blue: v("blue"),

        iris: v("iris"),
        "iris-hot": v("iris-hot"),
        "iris-soft": v("iris-soft"),
        "iris-deep": v("iris-deep"),

        spectre: v("spectre"),
        "spectre-deep": v("spectre-deep"),
        amethyst: v("amethyst"),
        "amethyst-deep": v("amethyst-deep"),

        ok: v("ok"),
        warn: v("warn"),
        bad: v("bad"),
      },
      backgroundImage: {
        brand: "var(--gradient-brand)",
        action: "var(--gradient-action)",
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
        iris: "0 0 0 1px rgb(var(--iris-rgb) / 0.5), 0 10px 40px -10px rgb(var(--indigo-rgb) / 0.6)",
        spectre: "0 0 0 1px rgb(var(--spectre-rgb) / 0.45), 0 10px 40px -10px rgb(var(--blue-rgb) / 0.5)",
      },
      keyframes: {
        "iris-flow": {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
        },
        breathe: {
          "0%, 100%": { opacity: "0.55" },
          "50%": { opacity: "1" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        "iris-flow": "iris-flow 6s ease-in-out infinite",
        breathe: "breathe 2.4s ease-in-out infinite",
        shimmer: "shimmer 1.6s linear infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
