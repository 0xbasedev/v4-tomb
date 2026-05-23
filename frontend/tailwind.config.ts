import type { Config } from "tailwindcss";

/**
 * Old Money Tailwind config.
 *
 * Three palette modes per docs/eighties-design skill:
 *   - miami   (Miami / New Wave — Vice / Nagel / pastel editorial)
 *   - memphis (Memphis Group / postmodern furniture / design magazines)
 *   - arcade  (Dark arcade / action-movie one-sheet / album cover)
 *
 * Mode is selected per-screen — Miami is the default for marketing/hero zones,
 * Arcade is for live-data dashboards, Memphis is a supporting accent.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ----- Miami / New Wave -----
        "miami-ground": "#f8f0e8",
        "miami-ground-blush": "#fff0f0",
        "miami-ground-lavender": "#faf0ff",
        "miami-pink": "#ff1493",
        "miami-pink-soft": "#ff69b4",
        "miami-teal": "#00ced1",
        "miami-teal-soft": "#20b2aa",
        "miami-orange": "#ff6600",
        "miami-yellow": "#ffe600",
        "miami-night": "#0a0a1a",
        "miami-night-violet": "#1a0a2e",

        // ----- Memphis / postmodern -----
        "memphis-white": "#ffffff",
        "memphis-red": "#ff0040",
        "memphis-yellow": "#ffe600",
        "memphis-blue": "#0066ff",
        "memphis-orange": "#ff6600",
        "memphis-green": "#00cc44",
        "memphis-violet": "#cc00ff",
        "memphis-black": "#111111",

        // ----- Arcade / action -----
        "arcade-ground": "#0a0510",
        "arcade-chrome": "#e0e0e0",
        "arcade-magenta": "#ff1493",
        "arcade-cyan": "#00ffff",
        "arcade-red": "#ff2200",
        "arcade-gold": "#ffd700",
        "arcade-purple": "#9900ff",

        // ----- Supplements (gold + oxblood per memory ref) -----
        gold: "#c5a572",
        "gold-soft": "#e3c98c",
        oxblood: "#4a0d0d",
        "oxblood-deep": "#2a0606",
      },
      fontFamily: {
        // Compressed italic grotesque — action/arcade headlines
        headline: [
          "Oswald",
          "Impact",
          "Handel Gothic",
          "Bank Gothic",
          "Arial Narrow",
          "sans-serif",
        ],
        // Slab serif — Miami / Memphis headlines + body
        slab: [
          "Rockwell",
          "Clarendon",
          "Courier New",
          "Georgia",
          "serif",
        ],
        // Compressed italic — subheads
        sub: [
          "Oswald",
          "Franklin Gothic Medium",
          "Impact",
          "sans-serif",
        ],
        // Body — same as slab; the skill says body is slab or compressed
        body: [
          "Rockwell",
          "Courier New",
          "Georgia",
          "serif",
        ],
      },
      fontSize: {
        // Per skill type scale
        hero: ["clamp(48px, 9vw, 120px)", { lineHeight: "1.0", fontWeight: "900" }],
        section: ["clamp(32px, 5vw, 56px)", { lineHeight: "1.05", fontWeight: "700" }],
        subhead: ["clamp(20px, 2.5vw, 32px)", { lineHeight: "1.15", fontWeight: "600" }],
        label: ["12px", { lineHeight: "1.2", fontWeight: "600", letterSpacing: "0.15em" }],
      },
      boxShadow: {
        // Hard offset, zero blur — the canonical 80s shadow
        "hard-pink": "6px 6px 0px #ff1493",
        "hard-teal": "6px 6px 0px #00ced1",
        "hard-orange": "6px 6px 0px #ff6600",
        "hard-yellow": "6px 6px 0px #ffe600",
        "hard-cyan": "6px 6px 0px #00ffff",
        "hard-gold": "6px 6px 0px #ffd700",
        "hard-magenta": "6px 6px 0px #ff1493",
        "hard-night": "6px 6px 0px #0a0a1a",
        "hard-oxblood": "6px 6px 0px #4a0d0d",
        "hard-pink-sm": "3px 3px 0px #ff1493",
        "hard-teal-sm": "3px 3px 0px #00ced1",
      },
      textShadow: {
        "hard-pink": "4px 4px 0px #ff1493",
        "hard-teal": "4px 4px 0px #00ced1",
        "hard-orange": "4px 4px 0px #ff6600",
        neon: "0 0 6px currentColor, 0 0 18px currentColor",
      },
      keyframes: {
        // Per skill animation grammar — neon flicker (on/off/on, steps timing)
        "neon-flicker": {
          "0%, 100%": {
            opacity: "1",
            "text-shadow": "0 0 6px currentColor, 0 0 14px currentColor",
          },
          "45%": { opacity: "0.9", "text-shadow": "0 0 4px currentColor" },
          "46%": { opacity: "0.2", "text-shadow": "none" },
          "47%": {
            opacity: "1",
            "text-shadow": "0 0 6px currentColor, 0 0 14px currentColor",
          },
          "80%": { opacity: "0.95" },
          "81%": { opacity: "0.3", "text-shadow": "none" },
          "82%": {
            opacity: "1",
            "text-shadow": "0 0 6px currentColor, 0 0 14px currentColor",
          },
        },
        "slide-in-right": {
          "0%": { transform: "translateX(60px)", opacity: "0" },
          "100%": { transform: "translateX(0)", opacity: "1" },
        },
        "scale-pop": {
          "0%": { transform: "scale(0.8)" },
          "60%": { transform: "scale(1.05)" },
          "100%": { transform: "scale(1)" },
        },
      },
      animation: {
        // step(1) timing on the flicker is essential — it's not a smooth dimmer
        "neon-flicker": "neon-flicker 4s steps(1) infinite",
        "slide-in": "slide-in-right 400ms cubic-bezier(0.25, 0, 0.5, 1.5)",
        "scale-pop": "scale-pop 250ms cubic-bezier(0.34, 1.56, 0.64, 1)",
      },
    },
  },
  plugins: [
    // Custom plugin for text-shadow utilities (Tailwind doesn't ship them)
    function ({ addUtilities, theme }: any) {
      const textShadows = theme("textShadow", {}) as Record<string, string>;
      const utilities = Object.fromEntries(
        Object.entries(textShadows).map(([key, value]) => [
          `.text-shadow-${key}`,
          { "text-shadow": value },
        ]),
      );
      addUtilities(utilities);
    },
  ],
} satisfies Config;
