/** @type {import('tailwindcss').Config} */
/**
 * Kin design tokens — from kin-desktop-ui-redesign (2f).
 * Dark-first Apple-native palette; status colors only for running / approval / success / error.
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
          sidebar: "var(--kin-sidebar)",
          chat: "var(--kin-chat)",
          inspector: "var(--kin-inspector)",
          hairline: "var(--kin-hairline)",
          "hairline-strong": "var(--kin-hairline-strong)",
          // Structural dividers (sidebar/main, section splits). Soft hairline, not default gray.
          border: "var(--kin-hairline)",
          text: "var(--kin-text)",
          secondary: "var(--kin-secondary)",
          tertiary: "var(--kin-tertiary)",
          muted: "var(--kin-muted)",
          blue: "#0A84FF",
          "blue-soft": "rgba(10, 132, 255, 0.14)",
          orange: "#FF9F0A",
          "orange-soft": "rgba(255, 159, 10, 0.12)",
          green: "#30D158",
          red: "#FF453A",
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
