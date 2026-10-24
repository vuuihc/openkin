/** @type {import('tailwindcss').Config} */
/**
 * Kin design tokens — the *scale* ladders only.
 *
 * Colours are written in `src/design/theme.css` and referenced here by name;
 * this file must not contain a colour value (the tokens test rejects one), and
 * the semantic pair — `bg-kin-panel` in dark vs light — comes from the
 * variable, not from a second definition here.
 *
 * Status colours are still literals: `#0A84FF`, `#FF9F0A`, `#30D158` and
 * `#FF453A` are the dark-mode values and do not switch, which is why every one
 * of them fails 4.5:1 on a light page. They move to variables — as RGB channel
 * triplets, so `border-kin-red/40` keeps working — with the rest of the status
 * work.
 */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        kin: {
          bg: "var(--kin-bg)",
          elevated: "var(--kin-elevated)",
          // Solid floating surface (modals/cards). Never leave undefined — missing token = transparent.
          panel: "var(--kin-panel)",
          sidebar: "var(--kin-sidebar)",
          inspector: "var(--kin-inspector)",
          hairline: "var(--kin-hairline)",
          "hairline-strong": "var(--kin-hairline-strong)",
          // Structural dividers (sidebar/main, section splits). Soft hairline, not default gray.
          border: "var(--kin-hairline)",
          text: "var(--kin-text)",
          secondary: "var(--kin-secondary)",
          muted: "var(--kin-muted)",
          // Alias used by primary action buttons across project/routines pages.
          accent: "#0A84FF",
          blue: "#0A84FF",
          "blue-soft": "rgba(10, 132, 255, 0.14)",
          orange: "#FF9F0A",
          "orange-soft": "rgba(255, 159, 10, 0.12)",
          green: "#30D158",
          red: "#FF453A",
          warning: "var(--kin-warning)",
        },
        // Keep legacy aliases so unmigrated bits don't break mid-refactor.
        surface: {
          DEFAULT: "var(--kin-bg)",
          raised: "var(--kin-elevated)",
          border: "var(--kin-hairline-strong)",
        },
        accent: {
          DEFAULT: "#0A84FF",
          muted: "#409CFF",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "SF Pro Display",
          "system-ui",
          "sans-serif",
        ],
        mono: ["ui-monospace", "SF Mono", "Menlo", "monospace"],
      },
      borderRadius: {
        card: "12px",
        pill: "9999px",
      },
      boxShadow: {
        window: "0 40px 90px -20px rgba(0,0,0,.7)",
        card: "0 8px 24px -12px rgba(0,0,0,.45)",
        "card-blue": "0 8px 24px -12px rgba(10,132,255,.4)",
        "card-amber": "0 10px 28px -10px rgba(255,159,10,.35)",
      },
      keyframes: {
        breathe: {
          "0%, 100%": { opacity: "1", transform: "scale(1)" },
          "50%": { opacity: "0.35", transform: "scale(0.82)" },
        },
        slideIn: {
          from: { opacity: "0", transform: "translateY(8px) scale(0.99)" },
          to: { opacity: "1", transform: "none" },
        },
        dashmove: {
          to: { backgroundPosition: "200% 0" },
        },
      },
      animation: {
        breathe: "breathe 1.8s ease-in-out infinite",
        slideIn: "slideIn 0.35s ease-out",
        dashmove: "dashmove 1.6s linear infinite",
      },
    },
  },
  plugins: [],
};
