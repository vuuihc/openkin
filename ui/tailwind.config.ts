import type { Config } from "tailwindcss";
import { FONT_SIZE } from "./src/design/type.ts";
/**
 * Kin design tokens — the *scale* ladders only.
 *
 * Semantic colours are written in `src/design/theme.css` and referenced here by
 * name, so the pair — `bg-kin-panel` in dark vs light — comes from the
 * variable, not from a second definition here. What literal colours remain are
 * the status and brand set (`#0A84FF`, `#FF9F0A`, `#30D158`, `#FF453A`) and the
 * black alphas inside the elevation shadows; the status ones are the dark-mode
 * values and do not switch, which is why every one of them fails 4.5:1 on a
 * light page. They move to variables — as RGB channel triplets, so
 * `border-kin-red/40` keeps working — with the rest of the status work.
 *
 * The scale ladders are *assigned* rather than extended, and that is the whole
 * mechanism: a leftover default name emits no CSS at all, so the guards in
 * `tokens.test.ts` can be a plain search instead of an allow-list. Font sizes
 * come from `src/design/type.ts`, the same array the `/design` gallery renders;
 * tracking, leading and elevation are written out here, one line per step, for
 * the same reason.
 *
 * Two ladders are the exception, each for its own reason. Radius is Tailwind's
 * own scale, not ours — S3's rule was no new numbers and no new names, so the
 * six steps the tree uses are a *subset* of the defaults, checked by name in the
 * guard rather than restated here. The layout widths are `extend`ed onto
 * Tailwind's `width`/`maxWidth`, because the literals they replace are the only
 * ones the ladder covers so far and the column ladder is P2's.
 *
 * The mechanisms fail differently, which is worth knowing when reading a
 * failure: an assigned ladder says "this name is on no step", a subset of
 * Tailwind's scale says "this name is off the six we chose", and an extended one
 * says "this value already has a name — use it".
 */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: "class",
  theme: {
    fontSize: FONT_SIZE,
    // One value per idiom. `label` is the uppercase section label (it was
    // `tracking-wide` at 59 sites and three hand-written values at 6 more);
    // `tight` is the page title and the brand mark; `normal` exists to undo
    // `label` inside it. Assigned, so `tracking-wider`/`widest` stop resolving.
    letterSpacing: {
      tight: "-0.025em",
      normal: "0",
      label: "0.06em",
    },
    // Two rulers, kept apart on purpose. `leading-<n>` is the 4px ruler the
    // fixed-height rows use — it is the same ruler as `min-h-*` and `gap-*`,
    // and it spans what the type ladder can need: 12px under `micro` through
    // 32px over `hero`. The three relative steps are for running text, where
    // the line box has to follow the font size. Assigned, so
    // `leading-tight`/`normal`/`relaxed`/`snug`/`loose` stop resolving.
    lineHeight: {
      "3": "0.75rem",
      "4": "1rem",
      "5": "1.25rem",
      "6": "1.5rem",
      "7": "1.75rem",
      "8": "2rem",
      prose: "1.625",
      ui: "1.375",
      flush: "1",
    },
    // Three levels and no more: a resting element on a surface (`e1`), a card
    // or overlay that has left it (`e2`), and a window or sheet above
    // everything (`e3`). Values do not switch by scheme — they are black alpha
    // over either backdrop, and nothing here is a colour a theme owns.
    // Assigned, so `shadow-sm`/`md`/`lg`/`xl`/`2xl`/`inner`/`none` stop
    // resolving; the guard in `tokens.test.ts` reads that as "search and fail".
    boxShadow: {
      e1: "0 1px 2px rgba(0, 0, 0, 0.24)",
      e2: "0 8px 24px -12px rgba(0, 0, 0, 0.45)",
      e3: "0 40px 90px -20px rgba(0, 0, 0, 0.7)",
    },
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
          // The keyboard focus ring, one token for all 16 of them — 11 spelled
          // `ring-kin-blue/*` and 5 spelled `ring-accent`, which is the same
          // brand blue in both themes. Two values per theme, because one blue
          // cannot clear 3:1 on both backdrops.
          "focus-ring": "var(--kin-focus-ring)",
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
      // The page columns that more than one screen measures itself against.
      // The rest of the widths in the tree are still literal (P2 picks the
      // column ladder); these four are the ones a second caller already needs.
      width: {
        sidebar: "248px",
      },
      maxWidth: {
        conversation: "720px",
        sheet: "min(100%, 420px)",
        inspector: "min(40%, 18rem)",
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
} satisfies Config;
