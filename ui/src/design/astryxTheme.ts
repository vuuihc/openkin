/**
 * The bridge between Kin's colour tokens and Astryx's semantic tokens.
 *
 * Astryx components paint through their own token names (`--color-accent`,
 * `--color-border`, …). Kin has its own inventory (`design/colors.ts`), and the
 * two are not the same shape: Astryx has semantic slots where Kin has a
 * measured ladder, and Kin has things Astryx has never heard of (agent identity
 * marks, a third ink step, a user bubble). This module is the one place that
 * says, token by token, which is which.
 *
 * The rule the test enforces is completeness, not coverage: every token in the
 * Kin inventory must appear here, either mapped to one or more Astryx tokens or
 * explicitly kept as a Kin extension with the reason. A new Kin token cannot
 * ship without a decision, and an Astryx token is left at its neutral default
 * until a component actually needs it — inventing a mapping now would be a
 * colour decision made without a screen to check it on.
 *
 * Values are not copied. A mapped token points at the Kin custom property, so
 * `design/theme.css` stays the only file with a colour in it and the Astryx
 * token follows the scheme the same way every Kin call site does.
 */
import { defineTheme } from "@astryxdesign/core";
import { neutralTheme } from "@astryxdesign/theme-neutral";
import { cssValue, PRESENTED_TOKENS } from "./colors";

/**
 * What happens to one Kin token.
 *
 * `astryx` lists the Astryx token names that take this Kin value. `extension`
 * is a reason, not a label: the token stays a Kin custom property because
 * Astryx has no slot with that meaning, and the facade reads the Kin name
 * directly for it.
 */
export type KinTokenBinding =
  { readonly astryx: readonly string[]; readonly note?: string } | { readonly extension: string };

/**
 * Every Kin token, and where it goes.
 *
 * The mapped side is deliberately semantic. A fill that means "success" goes
 * to `--color-success`, not to a palette slot, because the facade should ask
 * Astryx what a success surface is and get Kin's green back.
 */
export const KIN_TOKEN_BINDINGS: Readonly<Record<string, KinTokenBinding>> = {
  // Surfaces, from the window backdrop inward. Astryx's body/surface/card/
  // popover ladder is the same ladder Kin drew; the two middle steps that are
  // not on it are extensions below.
  "--kin-page": { astryx: ["--color-background-body"] },
  "--kin-bg": { astryx: ["--color-background-surface"] },
  "--kin-elevated-rgb": {
    astryx: ["--color-background-card"],
    note: "Kin's cards, popovers and active tab share one step; Astryx splits card from popover, so the popover slot takes the panel step instead.",
  },
  "--kin-panel-rgb": { astryx: ["--color-background-popover"] },
  "--kin-sidebar": {
    extension:
      "The navigation rail is its own surface in Kin. Astryx's AppShell has navigation variants rather than a sidebar colour token, and the shell slice (S1) decides how the rail is painted.",
  },
  "--kin-inspector": {
    extension:
      "The inspector is a third content surface between the page and a card. Astryx's ladder has no slot between surface and card; the workspace slice (W1) owns how the panel is painted.",
  },

  // Ink. Astryx has two steps; Kin's third (muted) is the one that carries
  // timestamps and captions and must not be painted as disabled.
  "--kin-text": { astryx: ["--color-text-primary", "--color-icon-primary"] },
  "--kin-secondary": { astryx: ["--color-text-secondary", "--color-icon-secondary"] },
  "--kin-muted-rgb": {
    extension:
      "Astryx's third step is --color-text-disabled, which means unavailable rather than quiet. Painting captions with it would say the wrong thing, so the facade keeps reading --kin-muted.",
  },

  // Lines and washes.
  "--kin-hairline": { astryx: ["--color-border"] },
  "--kin-hairline-strong": { astryx: ["--color-border-emphasized"] },
  "--kin-fill": { astryx: ["--color-background-muted"] },
  "--kin-fill-strong": {
    extension:
      "Astryx has one muted wash; Kin keeps a second, stronger step for pressed and selected controls.",
  },

  // Keyboard focus.
  "--kin-focus-ring": { astryx: ["--focus-outline-color"] },

  // Status fills. The fill is pigment and the same in both schemes, which is
  // exactly what Astryx's accent/status slots expect.
  "--kin-blue-rgb": { astryx: ["--color-accent", "--color-info"] },
  "--kin-orange-rgb": { astryx: ["--color-warning"] },
  "--kin-green-rgb": { astryx: ["--color-success"] },
  "--kin-red-rgb": { astryx: ["--color-error"] },

  // Status ink: text and glyphs drawn on a surface, not on the fill.
  "--kin-blue-ink-rgb": {
    astryx: [
      "--color-text-info",
      "--color-icon-info",
      "--color-text-accent",
      "--color-icon-accent",
    ],
  },
  "--kin-orange-ink-rgb": { astryx: ["--color-text-warning", "--color-icon-warning"] },
  "--kin-green-ink-rgb": { astryx: ["--color-text-success", "--color-icon-success"] },
  "--kin-red-ink-rgb": { astryx: ["--color-text-error", "--color-icon-error"] },

  // The two foregrounds a solid fill takes. Kin assigns them per fill; these
  // are the same decisions expressed as Astryx slots.
  "--kin-on-status": {
    astryx: ["--color-on-success", "--color-on-warning", "--color-on-error"],
    note: "Near-black, because three of the four Kin status fills are light pigments. Astryx's info slot is the blue fill, which takes --kin-on-brand instead.",
  },
  "--kin-on-brand": { astryx: ["--color-on-accent", "--color-on-info"] },

  // Identity and the user's own voice. These identify a third party or a
  // person's message; there is no Astryx slot with that meaning.
  "--kin-bubble-user": {
    extension: "The user's chat bubble is a conversation concept, not a control colour.",
  },
  "--kin-agent-claude": { extension: "Agent identity mark; the agent's own brand colour." },
  "--kin-agent-codex": { extension: "Agent identity mark; the agent's own brand colour." },
  "--kin-agent-droid": { extension: "Agent identity mark; the agent's own brand colour." },
  "--kin-agent-workbuddy": { extension: "Agent identity mark; the agent's own brand colour." },
  "--kin-agent-trae": { extension: "Agent identity mark; the agent's own brand colour." },
  "--kin-agent-doubao": { extension: "Agent identity mark; the agent's own brand colour." },
  "--kin-agent-zcode": { extension: "Agent identity mark; the agent's own brand colour." },

  // Elevation. Kin's tokens are the elevation colour; Astryx's are complete
  // box-shadow values with geometry baked in, so a colour cannot be written
  // into them without inventing offsets that contradict the Tailwind scale.
  "--kin-shadow-1": {
    extension:
      "Astryx elevation is a complete box-shadow value; Kin's is a colour plus the Tailwind scale's geometry. The facade translates the elevation classes instead.",
  },
  "--kin-shadow-2": {
    extension:
      "Astryx elevation is a complete box-shadow value; Kin's is a colour plus the Tailwind scale's geometry. The facade translates the elevation classes instead.",
  },
  "--kin-shadow-3": {
    extension:
      "Astryx elevation is a complete box-shadow value; Kin's is a colour plus the Tailwind scale's geometry. The facade translates the elevation classes instead.",
  },
};

/** Every Kin token that stays a Kin custom property, with its reason. */
export function kinExtensionTokens(): string[] {
  return PRESENTED_TOKENS.filter((name) => "extension" in KIN_TOKEN_BINDINGS[name]);
}

/**
 * The Astryx token write for one Kin token.
 *
 * A channel triplet needs the `rgb()` wrapper; `cssValue` is the same helper
 * the call sites use, so a token cannot be written one way here and another
 * way on a page.
 */
function valueFor(kinToken: string): string {
  return cssValue(kinToken);
}

/**
 * The flat Astryx token map handed to `defineTheme`.
 *
 * Built from the bindings rather than written out twice, so a mapping cannot
 * exist in the table and be missing from the theme.
 */
export function astryxTokenValues(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [kinToken, binding] of Object.entries(KIN_TOKEN_BINDINGS)) {
    if (!("astryx" in binding)) continue;
    for (const astryxToken of binding.astryx) {
      values[astryxToken] = valueFor(kinToken);
    }
  }
  return values;
}

/**
 * The touch floor.
 *
 * Astryx's controls are sized by three tokens (28/32/36 px), all of which are
 * `min-height` in its stylesheet. On a coarse pointer every one of them is
 * raised to 44px rather than only the small one, because a control's size is
 * chosen by the component, not by the hand using it. Kin's own buttons already
 * have a 44px floor in `index.css`; this is the same floor for anything that
 * comes through the facade.
 */
export const COARSE_POINTER_CONTROL_FLOOR = "44px";

const coarsePointerRule = {
  when: { pointer: "coarse" as const },
  value: {
    tokens: {
      "--size-element-sm": COARSE_POINTER_CONTROL_FLOOR,
      "--size-element-md": COARSE_POINTER_CONTROL_FLOOR,
      "--size-element-lg": COARSE_POINTER_CONTROL_FLOOR,
    },
  },
};

/**
 * The theme the console renders under.
 *
 * `motion` pins Astryx's own tempo and character, so Kin's motion is Astryx's
 * default rather than something a future upstream release changes quietly.
 * Reduce Motion is not a Kin preference: Astryx's stylesheets and animator
 * already follow `prefers-reduced-motion`, and `astryxTheme.test.ts` holds the
 * imported stylesheet to that promise.
 */
export const kinAstryxTheme = defineTheme({
  name: "kin",
  extends: neutralTheme,
  tokens: astryxTokenValues(),
  motion: { tempo: 1, character: "standard" },
  adaptations: { rules: [coarsePointerRule] },
});

/**
 * Kin's locale, as the BCP 47 tag Astryx resolves its catalog with.
 *
 * Kin ships `zh` (Simplified Chinese) and `en`; Astryx ships region-tagged
 * catalogs. `zh-Hans` would be the linguistically neat tag, but Astryx's
 * shipped catalog is `zh-CN`, and its resolver walks region subtags, not
 * script subtags, so the region tag is the one that finds the strings.
 */
export const ASTRYX_LOCALE_TAGS: Readonly<Record<string, string>> = {
  zh: "zh-CN",
  en: "en",
};

/** The Astryx locale for a Kin locale, falling back to the shipped English catalog. */
export function astryxLocaleFor(kinLocale: string): string {
  return ASTRYX_LOCALE_TAGS[kinLocale] ?? "en";
}
