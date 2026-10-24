import type { Config } from "tailwindcss";
import { FONT_SIZE } from "./src/design/type.ts";
/**
 * Kin design tokens — the *scale* ladders, and the names that reach the colour
 * tokens in `src/design/theme.css`.
 *
 * Every colour here is a reference: the values, both schemes of them, are in
 * that one file. The names are spelled out rather than derived, because the
 * guard in `tokens.test.ts` fails on a `var(--kin-*)` this file uses and
 * `theme.css` does not define, and a computed name would slip past it.
 *
 * The scale ladders are *assigned* rather than extended, and that is the whole
 * mechanism: a leftover default name emits no CSS at all, so the guards can be
 * a plain search instead of an allow-list. Font sizes come from
 * `src/design/type.ts`, the same array the `/design` gallery renders; tracking,
 * leading, elevation and the colour palette are written out here, one line per
 * step, for the same reason.
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
    //
    // A *status* glow is not a level: three cards used to cast a coloured
    // halo (`0 0 0 3px rgba(status, .25)`, `0 8px 24px rgba(status, .12)`),
    // which is a second way to say what the card's border and its ink already
    // say. The halo became a ring on the status fill and the glow became `e2`.
    boxShadow: {
      // Geometry only: the colour is `--kin-shadow-n`, because how dark a
      // shadow has to be is a function of the scheme and the offsets are a
      // function of the level. See the note on those tokens.
      e1: "0 1px 2px var(--kin-shadow-1)",
      e2: "0 8px 24px -12px var(--kin-shadow-2)",
      e3: "0 40px 90px -20px var(--kin-shadow-3)",
    },
    // Assigned, not extended: Tailwind's own palette is off, so `text-zinc-400`
    // — which the tree used 132 times, and which does not switch with the
    // scheme — emits nothing. This is the same mechanism as the ladders above,
    // and it is what lets the guard be a plain search for a class that produces
    // no CSS rather than an allow-list of names.
    colors: {
      transparent: "transparent",
      current: "currentColor",
      inherit: "inherit",
      black: "#000000",
      white: "#ffffff",
      kin: {
        bg: "var(--kin-bg)",
        // The two floating surfaces and the middle ink step are channel
        // triplets, because the tree draws them at an alpha (`bg-kin-elevated/60`
        // for the sticky headers, `text-kin-muted/50` for a disabled label).
        // Tailwind can only do that to `rgb(var(--x) / <alpha-value>)`; written
        // as `var(--x)`, the `/NN` is silently dropped and the class emits
        // nothing at all.
        elevated: "rgb(var(--kin-elevated-rgb) / <alpha-value>)",
        // Solid floating surface (modals/cards). Never leave undefined — missing token = transparent.
        panel: "rgb(var(--kin-panel-rgb) / <alpha-value>)",
        sidebar: "var(--kin-sidebar)",
        inspector: "var(--kin-inspector)",
        hairline: "var(--kin-hairline)",
        "hairline-strong": "var(--kin-hairline-strong)",
        fill: "var(--kin-fill)",
        "fill-strong": "var(--kin-fill-strong)",
        text: "var(--kin-text)",
        secondary: "var(--kin-secondary)",
        muted: "rgb(var(--kin-muted-rgb) / <alpha-value>)",
        // The keyboard focus ring, one token for all of them — 11 sites spelled
        // `ring-kin-blue/*`, 5 spelled `ring-accent`, 5 spelled
        // `outline-kin-blue`. Two values per scheme, because one blue cannot
        // clear 3:1 on both backdrops.
        "focus-ring": "var(--kin-focus-ring)",
        // Status, two tiers per family. `-ink` is text drawn on a surface and
        // is what the light scheme never had; the bare name is the fill (a bar,
        // a chip, a border, a button), the same value in both schemes.
        blue: "rgb(var(--kin-blue-rgb) / <alpha-value>)",
        "blue-ink": "rgb(var(--kin-blue-ink-rgb) / <alpha-value>)",
        orange: "rgb(var(--kin-orange-rgb) / <alpha-value>)",
        "orange-ink": "rgb(var(--kin-orange-ink-rgb) / <alpha-value>)",
        green: "rgb(var(--kin-green-rgb) / <alpha-value>)",
        "green-ink": "rgb(var(--kin-green-ink-rgb) / <alpha-value>)",
        red: "rgb(var(--kin-red-rgb) / <alpha-value>)",
        "red-ink": "rgb(var(--kin-red-ink-rgb) / <alpha-value>)",
        // Text *on* a solid fill. Two values, chosen per fill by measurement.
        "on-status": "var(--kin-on-status)",
        "on-brand": "var(--kin-on-brand)",
        "bubble-user": "var(--kin-bubble-user)",
        // The agents' own marks: third-party identity, the same in both schemes.
        "agent-claude": "var(--kin-agent-claude)",
        "agent-codex": "var(--kin-agent-codex)",
        "agent-droid": "var(--kin-agent-droid)",
        "agent-workbuddy": "var(--kin-agent-workbuddy)",
        "agent-trae": "var(--kin-agent-trae)",
        "agent-doubao": "var(--kin-agent-doubao)",
        "agent-zcode": "var(--kin-agent-zcode)",
      },
    },
    extend: {
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
