/**
 * KIN-MOBILE-002 R1 — the RN colour, type, spacing and radius layer.
 *
 * Every colour here is ported value-for-value from the desktop console's
 * `ui/src/design/theme.css`, which stays the source of truth: `tokens.parity.test.ts`
 * reads that file from disk and fails when the two drift, so a web colour change
 * cannot leave the phone behind. A web token written as a channel triplet
 * (`44 44 46`, which exists so Tailwind can put an opacity modifier on it)
 * becomes `rgb(44, 44, 46)` here; every other value keeps theme.css's spelling.
 *
 * Deliberately DOM-free (ADR 0036 §2): no `react` and no `react-native` import,
 * so the palette and its parity check run without a renderer. `useTheme.ts` is
 * the one file that knows about the platform.
 */

export type Scheme = "light" | "dark";

/**
 * One property per colour token in theme.css, camelCased. The CSS `-rgb` suffix
 * is a web implementation detail and is dropped: `--kin-elevated-rgb` is
 * `elevated`, `--kin-muted-rgb` is `muted`, `--kin-blue-ink-rgb` is `blueInk`.
 * Each value is an RN colour string: hex, `rgb(...)` or `rgba(...)`.
 */
export type Palette = {
  // Surfaces, from the window backdrop inward.
  page: string;
  sidebar: string;
  bg: string;
  inspector: string;
  /** A card, popover or the active tab. */
  elevated: string;
  /** A sheet or modal. */
  panel: string;
  // Elevation drop colours — the geometry is per level, the colour per scheme.
  shadow1: string;
  shadow2: string;
  shadow3: string;
  // Ink, three steps.
  text: string;
  secondary: string;
  /** Timestamps and labels; also drawn at reduced alpha on the web. */
  muted: string;
  // Lines and fills inside a surface.
  hairline: string;
  hairlineStrong: string;
  fill: string;
  fillStrong: string;
  /** WCAG 1.4.11 non-text indicator; opaque by contract. */
  focusRing: string;
  // Status: the `-rgb` fill is the pigment and does not switch with the scheme;
  // the matching ink does, so it stays readable as text.
  blue: string;
  blueInk: string;
  orange: string;
  orangeInk: string;
  green: string;
  greenInk: string;
  red: string;
  redInk: string;
  /** Text on a solid status or brand fill — assigned per fill, not per scheme. */
  onStatus: string;
  onBrand: string;
  /** The user's own chat bubble. */
  bubbleUser: string;
  // The agents' identity marks: the same value in both schemes by design.
  agentClaude: string;
  agentCodex: string;
  agentDroid: string;
  agentWorkbuddy: string;
  agentTrae: string;
  agentDoubao: string;
  agentZcode: string;
};

export const palette: Record<Scheme, Palette> = {
  dark: {
    page: "#0e0e10",
    sidebar: "#141416",
    bg: "#1a1a1c",
    inspector: "#222226",
    elevated: "rgb(44, 44, 46)",
    panel: "rgb(44, 44, 46)",
    shadow1: "rgba(0, 0, 0, 0.24)",
    shadow2: "rgba(0, 0, 0, 0.45)",
    shadow3: "rgba(0, 0, 0, 0.7)",
    text: "#f5f5f7",
    secondary: "#c7c7cc",
    muted: "rgb(152, 152, 157)",
    hairline: "rgba(255, 255, 255, 0.08)",
    hairlineStrong: "rgba(255, 255, 255, 0.14)",
    fill: "rgba(255, 255, 255, 0.06)",
    fillStrong: "rgba(255, 255, 255, 0.1)",
    focusRing: "#0a84ff",
    blue: "rgb(10, 132, 255)",
    blueInk: "rgb(108, 178, 255)",
    orange: "rgb(255, 159, 10)",
    orangeInk: "rgb(255, 179, 64)",
    green: "rgb(48, 209, 88)",
    greenInk: "rgb(141, 228, 160)",
    red: "rgb(255, 69, 58)",
    redInk: "rgb(255, 138, 128)",
    onStatus: "#1a1a1c",
    onBrand: "#ffffff",
    bubbleUser: "#0a84ff",
    agentClaude: "#d97757",
    agentCodex: "#10a37f",
    agentDroid: "#2f6fed",
    agentWorkbuddy: "#6f5bd3",
    agentTrae: "#f05a47",
    agentDoubao: "#2f7dff",
    agentZcode: "#202124",
  },
  light: {
    page: "#e0e0e5",
    sidebar: "#ececf0",
    bg: "#ffffff",
    inspector: "#ebebf0",
    elevated: "rgb(244, 244, 246)",
    panel: "rgb(255, 255, 255)",
    shadow1: "rgba(0, 0, 0, 0.03)",
    shadow2: "rgba(0, 0, 0, 0.06)",
    shadow3: "rgba(0, 0, 0, 0.08)",
    text: "#1c1c1e",
    secondary: "#3a3a3c",
    muted: "rgb(92, 92, 97)",
    hairline: "rgba(0, 0, 0, 0.09)",
    hairlineStrong: "rgba(0, 0, 0, 0.16)",
    fill: "rgba(0, 0, 0, 0.04)",
    fillStrong: "rgba(0, 0, 0, 0.08)",
    focusRing: "#0b6fe0",
    blue: "rgb(10, 132, 255)",
    blueInk: "rgb(10, 82, 180)",
    orange: "rgb(255, 159, 10)",
    orangeInk: "rgb(125, 68, 0)",
    green: "rgb(48, 209, 88)",
    greenInk: "rgb(16, 92, 39)",
    red: "rgb(255, 69, 58)",
    redInk: "rgb(165, 31, 24)",
    onStatus: "#1a1a1c",
    onBrand: "#ffffff",
    bubbleUser: "#007aff",
    agentClaude: "#d97757",
    agentCodex: "#10a37f",
    agentDroid: "#2f6fed",
    agentWorkbuddy: "#6f5bd3",
    agentTrae: "#f05a47",
    agentDoubao: "#2f7dff",
    agentZcode: "#202124",
  },
};

/**
 * Type roles from `mobile-rn/DESIGN.md`'s table, as RN text styles.
 *
 * `as const` keeps `fontWeight` a literal union (`"700"`, not `string`), which
 * is what RN's `TextStyle` accepts. `body`'s line height is 1.45 × 17.
 */
export const type = {
  largeTitle: { fontSize: 28, fontWeight: "700" },
  navTitle: { fontSize: 17, fontWeight: "600" },
  body: { fontSize: 17, fontWeight: "400", lineHeight: 24.65 },
  sub: { fontSize: 13, fontWeight: "400" },
  caption: { fontSize: 12, fontWeight: "400" },
  mono: { fontSize: 12, fontWeight: "400" },
} as const;

/**
 * DESIGN.md's 数字 row — token counts, amounts — as tabular figures, so a
 * column of numbers keeps its digits aligned. Spread beside a type role.
 *
 * The array is annotated rather than `as const`: RN's `fontVariant` takes a
 * mutable `FontVariant[]`, and a readonly tuple would not assign to it.
 */
export const tabular = { fontVariant: ["tabular-nums"] as "tabular-nums"[] };

/** The 4pt baseline: 4 / 8 / 12 / 16 / 20 / 24 / 32. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

/** Bubbles, cards and sheets; nested corners stay concentric. */
export const radius = {
  bubble: 10,
  card: 12,
  sheet: 20,
  composer: 22,
} as const;
