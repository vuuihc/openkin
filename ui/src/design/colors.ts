/**
 * The colour token inventory: the names, how they are drawn, and the pairings
 * that are decisions rather than measurements.
 *
 * This module exists because the same three facts have to be known in two
 * places — `pages/DesignSystemPage.tsx` renders every token, and
 * `design/tokens.test.ts` refuses to let one exist unrendered or unmeasured.
 * The page's list *was* the test's expectation before S4; the pairings are new,
 * and a pairing is exactly the kind of thing that goes stale when it is copied.
 *
 * Nothing here holds a value. `design/theme.css` is the only file in the console
 * with a colour in it; these are names, and the page renders them by asking the
 * browser what they resolved to.
 */

/**
 * `--kin-elevated-rgb` and friends are *channel triplets* (`44 44 46`) rather
 * than colours, because Tailwind can only put an opacity modifier on a triplet:
 * `bg-kin-elevated/60` compiles to `rgb(var(--kin-elevated-rgb) / 0.6)`, while
 * the same suffix on a plain colour emits no CSS at all. The suffix is the
 * whole contract, in both directions — a triplet has it, a colour does not —
 * and `tokens.test.ts` holds both ends of that.
 */
export function isTriplet(name: string): boolean {
  return name.endsWith("-rgb");
}

/** The token as a value a `style` property can take, triplet or not. */
export function cssValue(name: string): string {
  return isTriplet(name) ? `rgb(var(${name}) / 1)` : `var(${name})`;
}

export type TokenGroup = {
  labelKey: string;
  noteKey: string;
  /**
   * How the page draws it, and what the test can therefore assume:
   * `ink` is measured against the surfaces, `focus` is drawn as a ring on them,
   * `on-fill` is drawn on the fills it is paired with, `elevation` is a card
   * raised off a surface, `swatch` is a chip.
   */
  kind: "swatch" | "ink" | "focus" | "on-fill" | "elevation";
  /** These tokens are pigments a foreground is drawn on, so each needs a pairing. */
  fills?: boolean;
  /** These tokens are surfaces a colour is measured against. */
  surfaces?: boolean;
  tokens: readonly string[];
};

/**
 * The surfaces, from the window backdrop inward.
 *
 * One list, because two things read it: the gallery draws the ink ladders on
 * these rather than on a chip, and the test measures every ink and the focus
 * ring against them. The backdrop is in it because `AppShell` paints it on the
 * root and `<main>` inside paints nothing — so a page that does not paint its
 * own surface draws its text straight on the backdrop. That is most of them,
 * which is how `--kin-muted` came to be 3.84:1 there in the light scheme.
 */
const SURFACES = [
  "--kin-page",
  "--kin-sidebar",
  "--kin-bg",
  "--kin-inspector",
  "--kin-elevated-rgb",
  "--kin-panel-rgb",
] as const;

/**
 * Every surface — and, for the same reason, every surface an ink is measured on
 * and drawn on. There is no second list of "the ones ink actually lands on",
 * because that list is this one: the backdrop was left out of it once, on the
 * theory that pages paint their own surface, and a status chip on a page that
 * does not measured 4.41:1 in the light scheme.
 */
export const SURFACE_TOKENS: readonly string[] = SURFACES;

export const TOKEN_GROUPS: readonly TokenGroup[] = [
  {
    labelKey: "design.groupSurfaces",
    noteKey: "design.noteSurfaces",
    kind: "swatch",
    surfaces: true,
    tokens: SURFACES,
  },
  {
    labelKey: "design.groupInk",
    noteKey: "design.noteInk",
    kind: "ink",
    tokens: ["--kin-text", "--kin-secondary", "--kin-muted-rgb"],
  },
  {
    labelKey: "design.groupLines",
    noteKey: "design.noteLines",
    kind: "swatch",
    tokens: ["--kin-hairline", "--kin-hairline-strong", "--kin-fill", "--kin-fill-strong"],
  },
  {
    labelKey: "design.groupFocus",
    noteKey: "design.noteFocus",
    kind: "focus",
    tokens: ["--kin-focus-ring"],
  },
  {
    // One group, because they are one kind of thing: a pigment. The difference
    // between them is who owns the colour, not how it is drawn — and a status
    // fill and an agent's mark take the same two foregrounds.
    labelKey: "design.groupFills",
    noteKey: "design.noteFills",
    kind: "swatch",
    fills: true,
    tokens: [
      "--kin-blue-rgb",
      "--kin-orange-rgb",
      "--kin-green-rgb",
      "--kin-red-rgb",
      "--kin-bubble-user",
      "--kin-agent-claude",
      "--kin-agent-codex",
      "--kin-agent-droid",
      "--kin-agent-workbuddy",
      "--kin-agent-trae",
      "--kin-agent-doubao",
      "--kin-agent-zcode",
    ],
  },
  {
    labelKey: "design.groupStatusInk",
    noteKey: "design.noteStatusInk",
    kind: "ink",
    tokens: [
      "--kin-blue-ink-rgb",
      "--kin-orange-ink-rgb",
      "--kin-green-ink-rgb",
      "--kin-red-ink-rgb",
    ],
  },
  {
    labelKey: "design.groupOnFill",
    noteKey: "design.noteOnFill",
    kind: "on-fill",
    tokens: ["--kin-on-status", "--kin-on-brand"],
  },
  {
    // The elevation colour, one per level. The offsets and blurs are Tailwind's
    // (`e1`/`e2`/`e3`), because they are a function of the level; the colour is
    // a function of the scheme, which is why it is a token and not a literal in
    // the config, where it sat for three slices.
    labelKey: "design.groupElevation",
    noteKey: "design.noteElevation",
    kind: "elevation",
    tokens: ["--kin-shadow-1", "--kin-shadow-2", "--kin-shadow-3"],
  },
];

export const PRESENTED_TOKENS: string[] = TOKEN_GROUPS.flatMap((g) => [...g.tokens]);

/** Every token that is a pigment, gathered from the groups that say so. */
export const FILL_TOKENS: string[] = TOKEN_GROUPS.filter((g) => g.fills).flatMap((g) => [
  ...g.tokens,
]);

/**
 * The status family, by the name their classes use: `kin-blue`, `kin-orange`,
 * `kin-green`, `kin-red`.
 *
 * The agent marks and the user's bubble are fills too, but nothing certifies a
 * tint of them, and a mark is drawn whole — so they are the exception the tint
 * ceiling below does not speak for.
 */
export const TINTED_FILLS: readonly string[] = FILL_TOKENS.filter((n) => n.endsWith("-rgb")).map(
  (n) => n.slice("--".length, -"-rgb".length),
);

/**
 * How strong a status colour may be tinted while ink is drawn on it — and the
 * strength the measurement is taken at.
 *
 * A tint is not a fill. It is the pigment mixed with whatever surface happens to
 * be behind it, so the inks on it clear 4.5:1 against a *composite* rather than
 * against a declared value, and the margin shrinks as the tint strengthens. The
 * ceiling is set by the weakest ink that is legitimately drawn on a tint:
 * `--kin-muted` clears 4.5:1 over `--kin-bg` at 15% (worst pair 4.58:1) and
 * stops clearing it at 20%. At that same 15% the four status `-ink` steps,
 * `--kin-text` and `--kin-secondary` clear 4.5:1 over both `--kin-bg` and
 * `--kin-elevated-rgb` in both schemes — worst pair 5.19:1. All of it is
 * asserted in `tokens.test.ts`, and it is where a 40% tint was found putting the
 * light blue `-ink` at 4.41:1.
 *
 * Two things follow, and they are what the call sites are held to:
 *
 *  - a status colour carrying ink is a tint at or below this, or a solid at
 *    `TINT_SOLID` and above. In between there is no certification at all, and
 *    `tokens.test.ts` fails on it;
 *  - `--kin-muted` on a tint is certified over `--kin-bg` and not over
 *    `--kin-elevated-rgb` (3.63:1 there, at this ceiling). Raising the value far
 *    enough for `elevated` would leave it indistinguishable from
 *    `--kin-secondary`, so that is the muted step's own review rather than
 *    something a call site can fix; the note in `theme.css` records it.
 */
export const TINT_CEILING = 15;
/** Above this a status colour is its own surface rather than a wash. */
export const TINT_SOLID = 70;

/**
 * Which foreground each fill takes.
 *
 * This is the one decision in the colour layer that is not a measurement: a fill
 * is a pigment and does not switch with the scheme, so it cannot pick its own
 * text, and "white unless it is a light fill" is the sort of rule that gets a
 * new fill wrong. Assigned here, measured in the test, drawn on the page — every
 * fill appears exactly once, so a fill added without a decision fails.
 *
 * `--kin-on-status` is the near-black, and it is the majority because three of
 * the four status families are light pigments: white on the orange fill is
 * 2.06:1. `--kin-on-brand` is white, and the brand blue is the fill it was
 * chosen for.
 *
 * `min` is 4.5:1 — AA for the 13–15px labels these fills carry — except where a
 * pair is a known deferral, and then it is the 3:1 floor a UI component is held
 * to so the pair cannot quietly get worse. Both exceptions are the same colour:
 * white on the brand blue measures 3.65:1, and the alternative measured here
 * (near-black, 4.76:1) would restyle every primary button in the console. That
 * is a brand decision rather than a token one, so it is recorded here instead of
 * being fixed on the way past — see §7 of the P1 plan.
 */
export const FILL_INK: readonly { fill: string; ink: string; min?: number }[] = [
  { fill: "--kin-blue-rgb", ink: "--kin-on-brand", min: 3 },
  { fill: "--kin-bubble-user", ink: "--kin-on-brand", min: 3 },
  { fill: "--kin-orange-rgb", ink: "--kin-on-status" },
  { fill: "--kin-green-rgb", ink: "--kin-on-status" },
  { fill: "--kin-red-rgb", ink: "--kin-on-status" },
  { fill: "--kin-agent-claude", ink: "--kin-on-status" },
  { fill: "--kin-agent-codex", ink: "--kin-on-status" },
  { fill: "--kin-agent-droid", ink: "--kin-on-brand" },
  { fill: "--kin-agent-workbuddy", ink: "--kin-on-brand" },
  { fill: "--kin-agent-trae", ink: "--kin-on-status" },
  { fill: "--kin-agent-doubao", ink: "--kin-on-status" },
  { fill: "--kin-agent-zcode", ink: "--kin-on-brand" },
];

/** The two foregrounds, spelled once so the test can check the table only uses them. */
export const ON_FILL_INKS = ["--kin-on-status", "--kin-on-brand"] as const;
