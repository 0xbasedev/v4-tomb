import type { Config } from "tailwindcss";

/**
 * Old Money Tailwind config — Art Deco grammar.
 *
 * Per docs/skill-art-deco.md. Three palette modes:
 *   - Classic Black & Gold (default — warm black ground, ivory text, metallic gold)
 *   - Cream & Gold (editorial — ivory ground, near-black text)
 *   - Jewel & Gold (glamour — warm dark ground with one jewel-tone accent)
 *
 * "Old Money" = inherited wealth = Gatsby-era opulence. Art Deco is the natural
 * grammar — geometry as glamour, symmetry as power, ornament as structure.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ----- Classic Black & Gold (primary mode) -----
        "deco-ground": "#0d0a05",        // warm near-black (NOT pure black)
        "deco-ground-soft": "#1a1005",    // very dark warm brown
        "deco-ground-medium": "#241608",  // mid-tone for layered depth
        "deco-ivory": "#f5f0e0",          // antique ivory — primary text on dark
        "deco-ivory-soft": "#ebe5d2",     // slightly darker ivory
        "deco-cream": "#faf5e6",          // pale cream — ground for editorial mode
        "deco-gold": "#d4af37",           // mid gold (flat fallback)
        "deco-gold-light": "#f5e6a3",     // pale champagne (top of metallic gradient)
        "deco-gold-deep": "#a67c00",      // deep amber (gradient middle)
        "deco-gold-dark": "#8b6914",      // dark antique gold (secondary text)

        // ----- Jewel accents (use sparingly — one section max) -----
        "deco-emerald": "#1a5c3a",
        "deco-sapphire": "#1a2a5c",
        "deco-ruby": "#5c1a1a",
        "deco-teal": "#1a4a5c",

        // ----- Project supplements (from memory ref_eighties — still relevant) -----
        oxblood: "#4a0d0d",
        "oxblood-deep": "#2a0606",
      },
      fontFamily: {
        // Per skill: display = Bodoni/Didot family; body = Cormorant Garamond
        display: ['"Playfair Display"', '"Cormorant Garamond"', '"Bodoni MT"', '"Didot"', "serif"],
        headline: ['"Cormorant Garamond"', '"Bodoni MT"', '"Didot"', '"GFS Didot"', '"Times New Roman"', "serif"],
        body: ['"Cormorant Garamond"', "Garamond", "Georgia", "serif"],
        ornament: ['"Cinzel Decorative"', '"Trajan Pro"', "serif"],
        label: ['"Cinzel"', '"Cinzel Decorative"', '"Trajan Pro"', "serif"],
      },
      fontSize: {
        // Per skill: typography scale uses 1.333 perfect fourth multiplier
        hero: ["clamp(48px, 7vw, 96px)", { lineHeight: "1.0", fontWeight: "400", letterSpacing: "0.05em" }],
        section: ["clamp(32px, 4vw, 48px)", { lineHeight: "1.1", fontWeight: "400", letterSpacing: "0.08em" }],
        subhead: ["clamp(18px, 2vw, 24px)", { lineHeight: "1.3", fontWeight: "400", letterSpacing: "0.15em" }],
        label: ["11px", { lineHeight: "1.2", fontWeight: "600", letterSpacing: "0.3em" }],
      },
      keyframes: {
        // Per skill: only subtle, dignified motion. Gold shimmer + rule draw.
        "gold-shimmer": {
          "0%, 100%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
        },
        "rule-draw": {
          "0%": { transform: "scaleX(0)" },
          "100%": { transform: "scaleX(1)" },
        },
        "fade-in-center": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "sunburst-rotate": {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
      },
      animation: {
        "gold-shimmer": "gold-shimmer 4s linear infinite",
        "rule-draw": "rule-draw 800ms ease-in-out forwards",
        "fade-in-center": "fade-in-center 800ms ease-out forwards",
        "sunburst-rotate": "sunburst-rotate 120s linear infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
