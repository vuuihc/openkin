import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwindcss from "tailwindcss";
import resolveConfig from "tailwindcss/resolveConfig";
import { describe, expect, it } from "vitest";
import config from "../../tailwind.config.ts";
import {
  ELEVATION_CLASS,
  FILL_INK,
  FILL_TOKENS,
  ON_FILL_INKS,
  PRESENTED_TOKENS,
  SURFACE_TOKENS,
  TINTED_FILLS,
  TINT_CEILING,
  TINT_SOLID,
  TOKEN_GROUPS,
  isTriplet,
} from "./colors";
import { ROLE_PREVIEW, TYPE_ROLES, WEIGHT_CLASS } from "./type";

/**
 * The design layer's own consistency: the colour tokens and the type ladder.
 *
 * Everything here is a property of two files and the code between them, so it
 * needs no browser — except one case, which runs the real build over the real
 * tree to prove that every colour class in it produces CSS. `design/theme.css`
 * declares, `design/colors.ts` names the pairings, components reference, and
 * these tests are the only thing that has ever compared them. Before them, four
 * references pointed at names that were never defined and nothing noticed — a
 * panel width built from `--kin-ws-sidebar` silently became `auto`, and a
 * checkbox's accent built from `--kin-blue` did nothing at all.
 *
 * (This comment names tokens without the `var(` in front of them on purpose:
 * the reference scan reads this file too, raw, and a mention in prose is not a
 * use. Class names are the other way round — the scanners drop comments before
 * they read anything — so a class spelled out in a comment here is inert, and
 * the ones this file must not *see* can be named in the reasoning. The rule to
 * keep is the first one: prose may name a token, but only a call site may write
 * `var(`.)
 */

const UI = fileURLToPath(new URL("../..", import.meta.url));
// `generated` is deliberately *not* skipped: Tailwind's `content` glob scans it,
// so a guard that skipped it would be blind to a file the build reads — the same
// mismatch that left `index.html` outside every guard.
const SKIP_DIRS = new Set(["node_modules", "dist"]);

/** The ladders as Tailwind resolves them — read here, never copied. */
const theme = (
  resolveConfig(config) as unknown as { theme: Record<string, Record<string, string>> }
).theme;

/**
 * The radius steps the tree uses.
 *
 * The one allow-list written here rather than read out of the config, and for a
 * reason worth stating: the radius ladder is deliberately Tailwind's own scale
 * (`sm` 2 / `md` 6 / `lg` 8 / `xl` 12 / `2xl` 16 / `full`) rather than a ladder
 * of our own names — S3's rule was "no new numbers, no new names". So the
 * config has no `borderRadius` key at all, every other step of that scale still
 * resolves (a zero radius, and anything past `2xl`), and a guard that read the
 * config would be reading the whole default scale and could never fail. The
 * subset is the design decision; the case below holds it against the config so
 * it cannot drift into a name that does not exist.
 */
const RADIUS = ["sm", "md", "lg", "xl", "2xl", "full"];

function sourceFiles(): string[] {
  // The set Tailwind itself scans — `content` in `tailwind.config.ts` is
  // `./index.html` plus `./src/**/*.{js,ts,jsx,tsx}` — with `.css` added,
  // because a class name can also be written in the stylesheet. Starting the
  // walk at `src/` left `index.html` outside every guard, and a file the build
  // reads but the guard does not is exactly where a literal survives on a
  // ladder.
  const out = [join(UI, "index.html")];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(entry)) walk(full);
      } else if (/\.(ts|tsx|js|jsx|css)$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(join(UI, "src"));
  return out;
}

/**
 * The `--kin-*` blocks of the token layer, in file order.
 *
 * Three blocks, two schemes. The first is the shared one — the agents' identity
 * marks, the same in both — and it is selected by `:root` *and* the light
 * selectors together, so it cannot be classified by looking for the word
 * "light": a selector that names both schemes is neither. Reading it as light
 * would have been the whole bug, and quietly: the dark scheme would lose seven
 * tokens and the "same names in both schemes" case below would report them as
 * light-only.
 */
function schemeBlocks(): {
  scheme: "shared" | "dark" | "light";
  tokens: Record<string, string>;
  /** Names this block declares more than once — the later one wins, silently. */
  duplicates: string[];
}[] {
  const css = readFileSync(join(UI, "src/design/theme.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const blocks: {
    scheme: "shared" | "dark" | "light";
    tokens: Record<string, string>;
    duplicates: string[];
  }[] = [];
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const tokens: Record<string, string> = {};
    const duplicates: string[] = [];
    for (const [, name, value] of body.matchAll(/(--kin-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      if (name in tokens) duplicates.push(name);
      tokens[name] = value.trim();
    }
    if (Object.keys(tokens).length === 0) continue;
    const parts = selector.split(",").map((s) => s.trim());
    const light = parts.some((s) => s.includes("light"));
    // The dark block is also `:root`, so the bare selector alone says nothing:
    // a block is shared when it names the light scheme *and* the root element,
    // which is exactly the pair the shared block is written with.
    const shared = light && parts.some((s) => s === ":root");
    blocks.push({ scheme: shared ? "shared" : light ? "light" : "dark", tokens, duplicates });
  }
  return blocks;
}

const BLOCKS = schemeBlocks();
const SHARED = BLOCKS.find((b) => b.scheme === "shared")?.tokens ?? {};
/** Each scheme as the browser resolves it: the shared block, then its own. */
const DARK = { ...SHARED, ...(BLOCKS.find((b) => b.scheme === "dark")?.tokens ?? {}) };
const LIGHT = { ...SHARED, ...(BLOCKS.find((b) => b.scheme === "light")?.tokens ?? {}) };
const SCHEMES = [
  ["dark", DARK],
  ["light", LIGHT],
] as const;

type RGB = [number, number, number];

function hexRgb(value: string, where: string): RGB {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!hex) {
    throw new Error(`${where} is ${value}, and this check needs an opaque #rrggbb to measure`);
  }
  const n = parseInt(hex[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * A token as three channels, parsed by what its name says it is.
 *
 * The suffix decides, not a guess at the value: that is the contract the whole
 * token layer rests on, and a token whose spelling and value disagree should
 * fail loudly here rather than be quietly coerced.
 */
function colour(tokens: Record<string, string>, name: string, scheme: string): RGB {
  const value = tokens[name];
  if (value === undefined) throw new Error(`${scheme} ${name} is not declared`);
  if (!isTriplet(name)) return hexRgb(value, `${scheme} ${name}`);
  const parts = value.split(/\s+/);
  if (parts.length !== 3 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) {
    throw new Error(`${scheme} ${name} is ${value}, and a triplet is three channels 0-255`);
  }
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])] as RGB;
}

/** `top` drawn at `alpha` over `bottom` — a tint, which is what most fills are. */
function over(top: RGB, bottom: RGB, alpha: number): RGB {
  return top.map((c, i) => Math.round(c * alpha + bottom[i] * (1 - alpha))) as RGB;
}

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: RGB): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1–21. */
function contrast(a: RGB, b: RGB): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** CIE L\*, 0–100: perceptual lightness, so "2 apart" means "2 apart to the eye". */
function lightness(colour: RGB): number {
  const y = luminance(colour);
  return y > 0.008856 ? 116 * y ** (1 / 3) - 16 : 903.3 * y;
}

describe("design tokens", () => {
  it("has one shared block and one block per scheme, and no others", () => {
    expect(BLOCKS.map((b) => b.scheme)).toEqual(["shared", "dark", "light"]);
  });

  it("declares the same names in both schemes", () => {
    const dark = Object.keys(DARK).sort();
    const light = Object.keys(LIGHT).sort();
    // A token defined for one scheme only is invisible in the other: it either
    // falls back to nothing (transparent) or keeps the other scheme's value.
    expect(light.filter((n) => !dark.includes(n))).toEqual([]);
    expect(dark.filter((n) => !light.includes(n))).toEqual([]);
  });

  it("declares no token twice inside one block", () => {
    // The loser of a duplicate is invisible: the name is declared, the guard
    // above sees one name in each scheme, and the value that renders is
    // whichever was written last. It is a plausible edit — the shared block sits
    // in the same file and is folded into both schemes, so a token moved out of
    // a scheme block and left behind is exactly this.
    expect(BLOCKS.flatMap((b) => b.duplicates.map((n) => `${b.scheme}: ${n}`))).toEqual([]);
  });

  it("declares a shared token in the shared block only", () => {
    // The shared block is folded into both schemes, so a name in it *and* in a
    // scheme block is two writers for one value and a silent precedence rule.
    const shared = Object.keys(SHARED);
    expect(shared.filter((n) => n in (BLOCKS[1]?.tokens ?? {}) || n in (BLOCKS[2]?.tokens ?? {}))) //
      .toEqual([]);
    expect(shared.length).toBeGreaterThan(0);
  });

  it("writes every channel triplet as three channels, and nothing else as one", () => {
    // The suffix is a contract both ways. A triplet written without it cannot
    // take an opacity modifier — the `/NN` compiles to nothing at all, which is
    // how 43 backgrounds and text colours in this console came to render as
    // white space — and a colour written *with* it is three numbers where a
    // colour was expected, so it renders as nothing either. Both directions fail
    // here instead.
    for (const [scheme, tokens] of SCHEMES) {
      for (const [name, value] of Object.entries(tokens)) {
        const threeNumbers = /^\d{1,3} \d{1,3} \d{1,3}$/.test(value.trim());
        expect({ scheme, name, suffixMatchesValue: isTriplet(name) === threeNumbers }).toEqual({
          scheme,
          name,
          suffixMatchesValue: true,
        });
        if (isTriplet(name)) colour(tokens, name, scheme); // throws if out of range
      }
    }
  });

  it("wraps a triplet in rgb() wherever it is written by hand", () => {
    // A triplet name on its own inside `var( … )` is `44 44 46` where the
    // browser wanted a colour: the declaration is dropped and the property keeps its inherited
    // value, so the element is the wrong colour rather than visibly broken.
    // Tailwind's own mapping does this correctly; this is about the stylesheet
    // and the few `style={{ … }}` call sites.
    const bad: string[] = [];
    for (const file of [...sourceFiles(), join(UI, "tailwind.config.ts")]) {
      const source = readFileSync(file, "utf8");
      for (const [match] of source.matchAll(/(?<!rgb\()var\(--kin-[a-z0-9-]+-rgb\)/g)) {
        bad.push(`${relative(UI, file)}: ${match}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("pairs the config's alpha-value wrapper with the theme's triplet", () => {
    // The wrapper and the suffix are one decision written in two files, and both
    // directions fail silently: `<alpha-value>` on a `var(--x)` that is a plain
    // colour makes the `/NN` form emit no CSS at all, and `var(--x)` on a
    // triplet throws the modifier away. `theme.colors.kin` is the only place the
    // wrapper is written, so it is read rather than trusted.
    const kin = (theme as unknown as { colors: Record<string, Record<string, string>> }).colors.kin;
    const wrong: string[] = [];
    const wrapped = new Set<string>();
    for (const [name, value] of Object.entries(kin)) {
      const variable = /var\((--kin-[a-z0-9-]+)\)/.exec(value)?.[1];
      if (variable === undefined || !(variable in DARK)) {
        wrong.push(`${name}: ${value}`);
        continue;
      }
      if (value.includes("<alpha-value>")) {
        wrapped.add(variable);
        if (!isTriplet(variable)) wrong.push(`${name}: ${value}`);
      } else if (isTriplet(variable)) {
        wrong.push(`${name}: ${value}`);
      }
    }
    expect(wrong).toEqual([]);
    // The same defect from the other side: a triplet in the theme that no class
    // reaches with an alpha. `text-kin-muted/50` is a real call site, and it
    // compiles to nothing when the config declares `muted` with a plain `var()`
    // instead of the wrapper.
    const triplets = Object.keys(DARK).filter(isTriplet);
    expect(triplets.filter((n) => !wrapped.has(n))).toEqual([]);
    expect(triplets.length).toBeGreaterThan(8);

    // And the third direction — `rgb()` around a token that is already a colour.
    // `rgb(#1a1a1c)` parses in a modern browser, so it renders rather than
    // failing, which is why it needs a guard instead of a bug report.
    const wrappedColour: string[] = [];
    for (const file of [...sourceFiles(), join(UI, "tailwind.config.ts")]) {
      for (const [match, name] of readFileSync(file, "utf8").matchAll(
        /rgb\(var\((--kin-[a-z0-9-]+)\)/g,
      )) {
        if (!isTriplet(name)) wrappedColour.push(`${relative(UI, file)}: ${match}`);
      }
    }
    expect(wrappedColour).toEqual([]);
  });

  it("resolves every var(--kin-*) the code references", () => {
    const defined = new Set(Object.keys(DARK));
    const dangling: string[] = [];
    const files = [...sourceFiles(), join(UI, "tailwind.config.ts")];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const [, name] of source.matchAll(/var\((--kin-[a-z0-9-]+)/g)) {
        if (!defined.has(name)) dangling.push(`${relative(UI, file)}: ${name}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it("presents every token on the design page", () => {
    const defined = Object.keys(DARK).sort();
    const presented = [...PRESENTED_TOKENS].sort();
    const missing = defined.filter((n) => !presented.includes(n));
    const extra = presented.filter((n) => !defined.includes(n));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    expect(new Set(PRESENTED_TOKENS).size).toBe(PRESENTED_TOKENS.length);
  });

  it("gives every fill exactly one foreground, and that pairing is legible", () => {
    // A fill is a pigment: it does not switch with the scheme, so it cannot
    // choose its own text, and the choice is a decision rather than a
    // measurement — `design/colors.ts` assigns it, and this is where the
    // assignment is checked. Totality is the point: a fill added without a
    // decision fails here rather than shipping with whatever text was nearby.
    const paired = FILL_INK.map((p) => p.fill).sort();
    expect(paired).toEqual([...FILL_TOKENS].sort());
    expect(new Set(paired).size).toBe(paired.length);
    for (const { fill, ink, min } of FILL_INK) {
      expect({ fill, inkIsAForeground: (ON_FILL_INKS as readonly string[]).includes(ink) }).toEqual(
        {
          fill,
          inkIsAForeground: true,
        },
      );
      // 4.5:1 unless the pair is a recorded deferral, and then 3:1 — the
      // threshold for a UI component, which is what a button label is at worst.
      const floor = min ?? 4.5;
      for (const [scheme, tokens] of SCHEMES) {
        // The fill is scheme-independent by design; the foreground is not, so
        // the pair is measured twice — in the scheme whose foreground it is.
        const ratio = contrast(colour(tokens, ink, scheme), colour(tokens, fill, scheme));
        expect({ scheme, fill, ink, atLeast: ratio >= floor }).toEqual({
          scheme,
          fill,
          ink,
          atLeast: true,
        });
      }
    }
  });

  it("measures the surfaces where they are declared", () => {
    for (const [, tokens] of SCHEMES) {
      expect(SURFACE_TOKENS.filter((n) => tokens[n] === undefined)).toEqual([]);
    }
    // The group the page draws and the list the cases below measure are the same
    // list, so a surface cannot be added to one and left out of the other.
    expect(
      TOKEN_GROUPS.filter((g) => g.surfaces)
        .flatMap((g) => [...g.tokens])
        .sort(),
    ).toEqual([...SURFACE_TOKENS].sort());
    // One list serves both jobs, which is the decision worth holding: `--kin-page`
    // is a surface ink is *drawn* on, because `AppShell` paints it on the root and
    // the `<main>` inside paints nothing — so most pages draw their captions on
    // the backdrop, and a status chip doing exactly that is what moved the light
    // `muted` step and the backdrop with it. Drop it from the list and the ink
    // cases stop measuring it while the page keeps painting it.
    expect(SURFACE_TOKENS).toContain("--kin-page");
  });

  it("keeps every surface far enough from --kin-bg to be seen without a border", () => {
    for (const [scheme, tokens] of SCHEMES) {
      const base = lightness(colour(tokens, "--kin-bg", scheme));
      // `panel` is exempt: a sheet is separated from what is behind it by its
      // scrim, not by its own lightness, and in light mode it is deliberately
      // the same white as the content it covers.
      for (const name of ["--kin-page", "--kin-sidebar", "--kin-inspector", "--kin-elevated-rgb"]) {
        const delta = Math.abs(lightness(colour(tokens, name, scheme)) - base);
        expect({ scheme, name, atLeast2L: delta >= 2 }).toEqual({ scheme, name, atLeast2L: true });
      }
    }
  });

  /**
   * The elevation colour is the scheme's, the geometry is the level's.
   *
   * Until S5 one pair of black alphas served both schemes: a drop tuned on the
   * dark backdrop and drawn unchanged under a light modal, where 70% black is a
   * bruise. The fix moved the colour out of the config and into the token layer,
   * so these four hold the two halves apart — the config's list and the theme's
   * list are the same list, no colour is written where the geometry is, the
   * levels ascend, and the light alphas are the dark ones *by measurement*
   * rather than by eye.
   */
  const SHADOW_LEVELS = Object.keys(DARK)
    .filter((name) => name.startsWith("--kin-shadow-"))
    .sort();

  /** The alpha of an elevation token, which is a black `rgba()` by construction. */
  function shadowAlpha(tokens: Record<string, string>, name: string, scheme: string): number {
    const value = tokens[name];
    const alpha = /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*([0-9.]+)\s*\)$/.exec(value ?? "");
    if (!alpha) {
      throw new Error(`${scheme} ${name} is ${value}, and an elevation colour is a black rgba()`);
    }
    return Number(alpha[1]);
  }

  it("points every elevation step at an elevation token, and every token at a step", () => {
    const referenced = [
      ...new Set(
        Object.values(theme.boxShadow).flatMap((value) =>
          [...value.matchAll(/var\((--kin-shadow-[0-9]+)\)/g)].map((m) => m[1]),
        ),
      ),
    ].sort();
    // The count floor is what keeps two empty lists from agreeing.
    expect(SHADOW_LEVELS.length).toBeGreaterThan(0);
    expect(SHADOW_LEVELS.length).toBe(Object.keys(theme.boxShadow).length);
    expect(referenced).toEqual(SHADOW_LEVELS);
  });

  it("keeps a colour literal out of the elevation geometry", () => {
    // A literal in the config renders in both schemes and belongs to no gallery
    // group, which is exactly how the pair this replaced stayed wrong for three
    // slices: it was visible in neither the page nor the tokens.
    const literals = Object.entries(theme.boxShadow)
      .filter(([, value]) => /#[0-9a-f]{3,8}|\brgba?\(|\bhsla?\(|\b(?:black|white)\b/i.test(value))
      .map(([name]) => name);
    expect(literals).toEqual([]);
  });

  it("keeps the elevation levels ascending, and the light scheme's the lighter one", () => {
    for (const [scheme, tokens] of SCHEMES) {
      const alphas = SHADOW_LEVELS.map((name) => shadowAlpha(tokens, name, scheme));
      const ascending = alphas.every((alpha, i) => i === 0 || alpha > alphas[i - 1]);
      expect({ scheme, ascending }).toEqual({ scheme, ascending: true });
      for (const name of SHADOW_LEVELS) {
        // Light inverts the backdrop, so "less alpha" is the only direction the
        // two schemes can be compared in directly; how much less is the case
        // below, which is the claim that actually matters.
        expect(shadowAlpha(LIGHT, name, "light")).toBeLessThan(shadowAlpha(DARK, name, "dark"));
      }
    }
  });

  it("darkens each scheme's backdrop by the same amount at every elevation level", () => {
    // The light alphas are not taste: each is the value that drops its own
    // backdrop by the L* its dark counterpart drops — 2.99 / 5.35 / 7.15
    // against 2.77 / 5.20 / 6.95, the residual being the two decimals a token
    // is written in. A third of an L* is what "the same" is allowed to mean,
    // which is close enough to the rounding that one step of alpha in either
    // direction goes red — see the red-verification in the plan.
    for (const name of SHADOW_LEVELS) {
      const drops = SCHEMES.map(([scheme, tokens]) => {
        const bg = colour(tokens, "--kin-bg", scheme);
        return lightness(bg) - lightness(over([0, 0, 0], bg, shadowAlpha(tokens, name, scheme)));
      });
      expect({ name, sameDrop: Math.abs(drops[0] - drops[1]) < 0.3 }).toEqual({
        name,
        sameDrop: true,
      });
    }
  });

  it("keeps every ink step above 4.5:1 on the surfaces it is drawn on", () => {
    for (const [scheme, tokens] of SCHEMES) {
      for (const name of TOKEN_GROUPS.filter((g) => g.kind === "ink").flatMap((g) => [
        ...g.tokens,
      ])) {
        for (const surface of SURFACE_TOKENS) {
          const ratio = contrast(colour(tokens, name, scheme), colour(tokens, surface, scheme));
          expect({ scheme, ink: name, surface, passes: ratio >= 4.5 }).toEqual({
            scheme,
            ink: name,
            surface,
            passes: true,
          });
        }
        // …and on its own fill at the tint ceiling. A status `-ink` is a *step*
        // of its fill's family, so the pair it has to survive is itself.
        if (!/-ink-rgb$/.test(name)) continue;
        const fill = `${name.replace(/-ink-rgb$/, "")}-rgb`;
        for (const surface of ["--kin-bg", "--kin-elevated-rgb"]) {
          const ratio = contrast(
            colour(tokens, name, scheme),
            over(colour(tokens, fill, scheme), colour(tokens, surface, scheme), TINT_CEILING / 100),
          );
          expect({
            scheme,
            ink: name,
            on: `${TINT_CEILING}% over ${surface}`,
            passes: ratio >= 4.5,
          }).toEqual({
            scheme,
            ink: name,
            on: `${TINT_CEILING}% over ${surface}`,
            passes: true,
          });
        }
      }
    }
  });

  it("certifies every ink a status tint carries, and the ceiling is where muted stops", () => {
    // A tint is a composite, so the ceiling is a property of the whole ladder:
    // it has to be the strongest tint at which *every* ink drawn on one still
    // clears 4.5:1. `--kin-muted` is the weakest of them and the one that sets
    // it — it passes over `--kin-bg` and fails over `--kin-elevated-rgb` at
    // this strength, which is why a muted caption on a tint is certified over
    // `bg` alone. The other two clear both surfaces with room, which is what
    // lets a tinted card sit on a panel.
    for (const [scheme, tokens] of SCHEMES) {
      for (const fill of TINTED_FILLS) {
        const pigment = colour(tokens, `--${fill}-rgb`, scheme);
        // Every surface, not just the two a tinted card is most often drawn on:
        // the ceiling is a property of the whole ladder, so the surface that
        // makes it fail decides it. `--kin-page` is in the list for the reason
        // above — a tinted chip on a page that paints nothing sits on it.
        const tints: readonly [string, RGB][] = SURFACE_TOKENS.map((surface) => [
          surface,
          over(pigment, colour(tokens, surface, scheme), TINT_CEILING / 100),
        ]);
        const drawn: readonly [string, readonly [string, RGB][]][] = [
          ["--kin-text", tints],
          ["--kin-secondary", tints],
          ["--kin-muted-rgb", tints.filter(([s]) => s === "--kin-bg")],
        ];
        for (const [ink, surfaces] of drawn) {
          for (const [surface, tint] of surfaces) {
            const ratio = contrast(colour(tokens, ink, scheme), tint);
            expect({
              scheme,
              ink,
              on: `${fill} at the ceiling over ${surface}`,
              passes: ratio >= 4.5,
            }).toEqual({
              scheme,
              ink,
              on: `${fill} at the ceiling over ${surface}`,
              passes: true,
            });
          }
        }
      }
    }
  });

  it("leaves no font size outside the type ladder", () => {
    // `theme.fontSize` is assigned, not extended, so a leftover default name
    // emits no CSS at all and the element silently inherits its parent's size.
    //
    // The names are written out because they are a fixed vocabulary of
    // Tailwind's, not a property of this config: once `fontSize` is assigned
    // they no longer exist in `resolveConfig`, so there is nothing to read them
    // from. Two things keep the list from rotting — it is the *complete* default
    // set (`5xl`…`9xl` included: a truncated list is a guard that cannot fail
    // for the names it forgot), and the arbitrary branch covers every unit a
    // size is written in, not just `px`.
    const leftovers: string[] = [];
    const old = /(?<![\w-])text-(?:\[[0-9.]+(?:px|rem|em|pt)\]|xs|sm|base|lg|xl|[2-9]xl)(?![\w-])/g;
    for (const file of sourceFiles()) {
      for (const [match] of readFileSync(file, "utf8").matchAll(old)) {
        leftovers.push(`${relative(UI, file)}: ${match}`);
      }
    }
    expect(leftovers).toEqual([]);
  });

  it("keeps every type role distinguishable from the others", () => {
    const seen = new Map<string, string>();
    for (const role of TYPE_ROLES) {
      const key = `${role.px}/${role.weight}/${role.ink}`;
      const clash = seen.get(key);
      expect({ role: role.role, clashesWith: clash ?? null }).toEqual({
        role: role.role,
        clashesWith: null,
      });
      seen.set(key, role.role);
    }
    const ascending = [...TYPE_ROLES].sort((a, b) => a.px - b.px);
    for (let i = 1; i < ascending.length; i++) {
      const [lower, upper] = [ascending[i - 1], ascending[i]];
      // One pixel apart is not a step: the role has to be told apart by weight
      // or ink as well, or the two are the same role with a rounding error.
      if (upper.px - lower.px !== 1) continue;
      expect({
        pair: `${lower.role}/${upper.role}`,
        differs: lower.weight !== upper.weight || lower.ink !== upper.ink,
      }).toEqual({ pair: `${lower.role}/${upper.role}`, differs: true });
    }
  });

  it("previews every type role with the classes the role declares", () => {
    expect(Object.keys(ROLE_PREVIEW).sort()).toEqual(TYPE_ROLES.map((r) => r.role).sort());
    for (const role of TYPE_ROLES) {
      const classes = ROLE_PREVIEW[role.role].split(/\s+/);
      // Tailwind only sees class names that appear verbatim, so the preview
      // cannot be assembled from the role; it is checked against it instead.
      expect(classes).toContain(`text-${role.role}`);
      expect(classes).toContain(WEIGHT_CLASS[role.weight]);
      expect(classes).toContain(`text-kin-${role.ink}`);
      // The role names a *Tailwind* colour, not a token: `muted` is a channel
      // triplet, so the token behind it is spelled differently. What has to hold
      // is that the name resolves, and that every name in the config resolves to
      // a token is the dangling-reference case above.
      expect((theme.colors.kin as unknown as Record<string, string>)[role.ink]).toBeDefined();
    }
  });

  it("keeps the focus ring measurable on every surface a control is focused on", () => {
    // WCAG 1.4.11: a non-text indicator needs 3:1. What the 16 sites carried
    // before was brand blue — 11 of them at 40–50% alpha, which managed
    // 1.49–2.13:1 across the surfaces a focused control actually sits on, and 5
    // opaque, which is 2.77:1 on the light page. So the old ring got two things wrong: alpha,
    // and one blue for two themes. `rgb()` refusing a non-opaque value is part
    // of the guard, not a limitation of it.
    //
    // `--kin-page` is in the list because it is the worst case, not because a
    // control usually sits there: the mobile tab bar and the sheet scrims are
    // drawn on it, and it is what forced the light value below brand blue.
    for (const [scheme, tokens] of SCHEMES) {
      for (const surface of SURFACE_TOKENS) {
        const ratio = contrast(
          colour(tokens, "--kin-focus-ring", scheme),
          colour(tokens, surface, scheme),
        );
        expect({ scheme, surface, atLeast3: ratio >= 3 }).toEqual({
          scheme,
          surface,
          atLeast3: true,
        });
      }
    }
  });

  it("draws every focus indicator in the focus-ring token", () => {
    // The contrast case above only ever measures `--kin-focus-ring`, so an
    // indicator spelled with some *other* colour passes it and still ships:
    // `accent` is a fixed brand blue — the same #0A84FF in both themes — and
    // 2.77:1 on the light page, well under 3:1. Five sites did exactly that,
    // and nothing in the tree said so, because an indicator that renders is an
    // indicator nobody checks.
    //
    // Three spellings reach the same pixels and all three are here: `ring-`,
    // `outline-` (five sites, where a ring would be clipped by an ancestor's
    // `overflow-hidden`), and `focus-within:` for a container that frames a
    // focused child. The value slot is where the colour lives, and it is the
    // token or nothing. Two spellings that used to pass are worse than a wrong
    // colour and are the reason for the `[^"'\s;]+` capture rather than a word
    // pattern: an arbitrary hex after the axis prefix is the same untokenised
    // blue, and an opacity modifier on the token renders **no indicator at
    // all**, because Tailwind cannot put a `/NN` on a `var()` colour.
    const widths: Record<string, Set<string>> = {
      ring: new Set([...Object.keys(theme.ringWidth), "inset"]),
      outline: new Set([...Object.keys(theme.outlineWidth), "none"]),
    };
    const bad: string[] = [];
    for (const file of sourceFiles()) {
      const source = readFileSync(file, "utf8");
      for (const [match, axis, name] of source.matchAll(
        /(?:focus|focus-within|focus-visible):(ring|outline)-(?!offset-)([^"'\s;]+)/g,
      )) {
        const ok = name === "kin-focus-ring" || widths[axis].has(name);
        // The message spells the fix the long way round, so the file stays
        // free of the very thing it forbids.
        if (!ok) bad.push(`${relative(UI, file)}: ${match} → ${axis}-kin-focus-ring`);
      }
    }
    expect(bad).toEqual([]);
  });

  /**
   * The scale ladders by name.
   *
   * `letterSpacing`, `lineHeight` and `boxShadow` are assigned rather than
   * extended — the same mechanism as the font sizes above — so a name the
   * config does not declare emits no CSS at all. A leftover is not an error, it
   * is silence: the element keeps whatever the browser or its parent gave it.
   * So the guard is a search again, and the ladder it searches for is read out
   * of the resolved config rather than copied here, which is what keeps the two
   * from drifting.
   *
   * Raw CSS declarations (`min-height: 44px` in `index.css`) are outside this:
   * they are the file's own geometry, not the utility vocabulary, and the
   * trailing `(?!:)` is what keeps `min-height:` from reading as a class name.
   */
  describe("scale ladders", () => {
    /** `axis` is a pattern fragment: `rounded-t-lg` is one axis, four letters. */
    const AXES: { axis: string; label: string; names: string[] }[] = [
      { axis: "leading", label: "leading", names: Object.keys(theme.lineHeight) },
      { axis: "tracking", label: "tracking", names: Object.keys(theme.letterSpacing) },
      { axis: "shado(?:w)", label: "elevation", names: Object.keys(theme.boxShadow) },
      {
        axis: "rounded(?:-(?:t|r|b|l|tl|tr|br|bl|s|e))?",
        label: "rounded",
        // A corner on its own (`rounded-t`) is the DEFAULT step, so the side
        // letter lands where a step name would be. The steps come from `RADIUS`
        // — see the note there for why this axis is the exception.
        names: [...RADIUS, "t", "r", "b", "l", "tl", "tr", "br", "bl", "s", "e"],
      },
      { axis: "min-h", label: "min-h", names: Object.keys(theme.minHeight) },
      { axis: "max-w", label: "max-w", names: Object.keys(theme.maxWidth) },
      { axis: "min-w", label: "min-w", names: Object.keys(theme.minWidth) },
      { axis: "w", label: "w", names: Object.keys(theme.width) },
    ];

    function offLadder(axis: string, names: string[]): string[] {
      // The name may contain `-`, so a wrong name is wrong rather than
      // invisible; the lookahead is what stops the capture at the end of the
      // class instead of eating the next one.
      const pattern = new RegExp(`(?<![\\w-])(?:${axis})-([a-z0-9-]+)(?![\\w-:])`, "g");
      const bad: string[] = [];
      for (const file of sourceFiles()) {
        for (const [match, name] of readFileSync(file, "utf8").matchAll(pattern)) {
          if (!names.includes(name)) bad.push(`${relative(UI, file)}: ${match}`);
        }
      }
      return bad;
    }

    for (const { axis, label, names } of AXES) {
      it(`leaves nothing off the ${label} ladder`, () => {
        expect(offLadder(axis, names)).toEqual([]);
      });
    }

    it("leaves no bare elevation step", () => {
      // Tailwind's DEFAULT name is the bare one, and assigning `boxShadow`
      // removes it: one site used it, and it was the one class in the tree that
      // would have gone on looking right in the source and rendering flat. The
      // word is split so this line does not name what it forbids.
      //
      // The cost of a plain word search is that prose in a scanned file cannot
      // use the word either — say "elevation step" here. That is a real
      // constraint on comments in `src/`, and a cheap one: the alternative is a
      // parser that knows a class string from a sentence.
      const pattern = /(?<![\w-])shado(?:w)(?![\w-:])/g;
      const bad: string[] = [];
      for (const file of sourceFiles()) {
        for (const [match] of readFileSync(file, "utf8").matchAll(pattern)) {
          bad.push(`${relative(UI, file)}: ${match}`);
        }
      }
      expect(bad).toEqual([]);
    });

    it("keeps the radius steps on Tailwind's scale", () => {
      // `RADIUS` is the one hand-written allow-list, so this is what keeps it
      // from being a guess: every step it names has to be a key of the resolved
      // radius scale. Drop one from Tailwind's defaults and this goes red
      // instead of the ladder quietly resolving to nothing.
      expect(RADIUS.filter((name) => theme.borderRadius[name] === undefined)).toEqual([]);
    });

    it("leaves no arbitrary value on an axis the ladder has words for", () => {
      // Three axes are vocabularies rather than rulers: after S3 every value in
      // the tree has a name, so an arbitrary radius is not "off the scale", it
      // is "no word for this". That is the same failure a leftover name gives,
      // except it *does* render — as a one-off nobody can find again. The font
      // sizes have the same rule in their own case above.
      //
      // Three axes are deliberately not here. `min-h` has a live survivor
      // (480px, above Tailwind's largest step) and its rule is the predicate
      // below. The elevation axis has five status glows that are S4's. The
      // layout widths are P2's — the column ladder is not written yet, so a
      // fourth width would be blocked for no reason.
      const axes = ["leading", "tracking", "rounded(?:-(?:t|r|b|l|tl|tr|br|bl|s|e))?"];
      const bad: string[] = [];
      for (const axis of axes) {
        const pattern = new RegExp(`(?<![\\w-])(?:${axis})-\\[[^\\]]+\\]`, "g");
        for (const file of sourceFiles()) {
          for (const [match] of readFileSync(file, "utf8").matchAll(pattern)) {
            bad.push(`${relative(UI, file)}: ${match}`);
          }
        }
      }
      expect(bad).toEqual([]);
    });

    /** A scale value in px, or null for the keywords (`100vh`, `min-content`). */
    function px(value: string): number | null {
      const match = /^([\d.]+)(px|rem)$/.exec(value);
      if (!match) return null;
      return Math.round(Number(match[1]) * (match[2] === "rem" ? 16 : 1));
    }

    it("writes an arbitrary min-h only where the ruler cannot express it", () => {
      // The 44px touch floor was the most common height in the tree, spelled as
      // an arbitrary value 52 times. Renaming those to `min-h-11` is only half
      // the point: the rule that keeps them renamed has to be a predicate,
      // because an exception list is what rots. One arbitrary value survives —
      // 480px, above Tailwind's largest step — and it survives by passing the
      // predicate, not by being listed.
      const expressible = new Set(
        Object.values(theme.minHeight)
          .map(px)
          .filter((value): value is number => value !== null),
      );
      const bad: string[] = [];
      for (const file of sourceFiles()) {
        const source = readFileSync(file, "utf8");
        for (const [match, value] of source.matchAll(/(?<![\w-])min-h-\[([^\]]+)\]/g)) {
          const size = /^(\d+)px$/.exec(value)?.[1];
          if (size && expressible.has(Number(size))) bad.push(`${relative(UI, file)}: ${match}`);
        }
      }
      expect(bad).toEqual([]);
    });

    it("does not spell out a container width the ladder already names", () => {
      // The widths are the one axis whose ladder is not a complete vocabulary.
      // A label's truncation cap and a control's box are supposed to stay
      // literals — see the note on `width` in `tailwind.config.ts` — so this
      // guard cannot be "no arbitrary width", the way the three axes above are.
      // What it can be is per *step*: a value the ladder names has exactly one
      // spelling in the tree, and it is the name.
      //
      // Every part of that is a fact about the config, which is the point. The
      // four names S7 started from were written out here; the thirteen it ended
      // with are read, so adding a step is what puts the tree under the rule and
      // a step whose value stopped matching its call sites is what this fails
      // on. Nothing in this case spells a width, so it cannot trip itself.
      //
      // Both spellings, because a value has two: the config writes px for every
      // step today, and the same width in rem is the same width.
      const spellings = (value: string): string[] => {
        const stripped = value.replace(/\s+/g, "");
        const px = /^([\d.]+)px$/.exec(stripped);
        const rem = /^([\d.]+)rem$/.exec(stripped);
        if (px) return [stripped, `${Number(px[1]) / 16}rem`];
        if (rem) return [stripped, `${Number(rem[1]) * 16}px`];
        return [stripped];
      };
      const ladder: [string, Record<string, string>][] = [
        ["w", config.theme.extend.width],
        ["max-w", config.theme.extend.maxWidth],
        ["min-w", config.theme.extend.minWidth],
      ];
      const bad: string[] = [];
      for (const file of sourceFiles()) {
        const source = readFileSync(file, "utf8");
        for (const [axis, steps] of ladder) {
          for (const [name, value] of Object.entries(steps)) {
            for (const spelling of spellings(value)) {
              const literal = `${axis}-[${spelling}]`;
              if (source.includes(literal)) {
                bad.push(`${relative(UI, file)}: ${literal} → ${axis}-${name}`);
              }
            }
          }
        }
      }
      expect(bad).toEqual([]);
    });
  });

  /**
   * The one case in this file that runs the real build.
   *
   * Every other guard here compares names, and names were never the problem: a
   * colour class that the config cannot resolve, or that carries an opacity
   * modifier on a value that cannot take one, is *deleted* rather than reported.
   * Tailwind's content scan finds nothing to generate, the class attribute keeps
   * its word, and the element renders with no background, no border, or the
   * inherited text colour. Forty-three sites shipped that way — `bg-kin-red/8`
   * and its neighbours on an opacity scale that has no step 8, and a family of
   * 40%-alpha fills built on an arbitrary value, where a `/NN` can never work.
   * None of them looked wrong in the source; that is the whole difficulty.
   *
   * So this compiles the tree through the same pipeline `npm run build` uses and
   * asks whether each colour class in it produced a rule. The candidate list is
   * read out of string literals only, because prose names the failures this
   * guards against, and a guard that fails on its own comments is a guard nobody
   * keeps. Test files are outside it for the same reason — they do not render.
   */
  describe("colour classes", () => {
    const AXES = [
      "bg",
      "text",
      "border",
      "border-t",
      "border-r",
      "border-b",
      "border-l",
      "border-x",
      "border-y",
      "border-s",
      "border-e",
      "from",
      "to",
      "via",
      "ring",
      "ring-offset",
      "fill",
      "stroke",
      "placeholder",
      "decoration",
      "divide",
      "outline",
      "accent",
      "caret",
    ].sort((a, b) => b.length - a.length);

    /**
     * The value part has to name a colour. Without this the scan also reads
     * `border-box` out of an inlined stylesheet and every other property name
     * that shares a prefix with an axis; non-colour ladders are S3's, and they
     * are guarded by name one describe block up.
     */
    const COLOUR = new RegExp(
      "^(?:" +
        [
          "kin-[a-z0-9-]+",
          "(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-[0-9]{2,3})?",
          "white",
          "black",
          "current",
          "transparent",
          "inherit",
          "\\[.*\\]",
        ].join("|") +
        ")$",
    );

    /**
     * The quoted runs in one file, with the comments taken out first.
     *
     * This replaced `split(/["'`]/).filter((_, i) => i % 2 === 1)` — "the odd
     * pieces are the strings" — which is cheap and quietly wrong: a single
     * apostrophe in a comment or in JSX copy (`don't`) flips the parity for the
     * rest of the file, and every class list after it is read as code and
     * skipped. Two of the six `bg-kin-blue text-kin-on-brand` buttons in
     * `Sidebar.tsx` were invisible to every case in this file for exactly that
     * reason, and nothing said so.
     *
     * Removing the comments first is what makes the parity trick unnecessary,
     * and the asymmetry is deliberate: a stray apostrophe now *joins* two
     * regions instead of dropping one, so the failure mode is a class name read
     * out of code rather than a class list nobody looked at. The first fails
     * loudly and names the file; the second is how the guard above came to have
     * a hole in it.
     */
    function strings(source: string): string[] {
      const found: string[] = [];
      let i = 0;
      while (i < source.length) {
        const c = source[i];
        if (c === "/" && source[i + 1] === "/") {
          while (i < source.length && source[i] !== "\n") i++;
          continue;
        }
        if (c === "/" && source[i + 1] === "*") {
          i += 2;
          while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
          i += 2;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") {
          i++;
          const start = i;
          while (i < source.length && source[i] !== c) {
            if (source[i] === "\\") i++;
            i++;
          }
          found.push(source.slice(start, i));
          i++;
          continue;
        }
        i++;
      }
      return found;
    }

    /**
     * The colour classes in one file, variant prefixes included. The scan inside
     * a quoted run is a walk rather than a pattern, because a value can be
     * bracketed and brackets nest — `bg-[rgb(var(--kin-red-rgb))]` is one class,
     * and a pattern that stops at the first `]` reads it as something else.
     */
    function candidates(source: string): string[] {
      return strings(source).flatMap(classesIn);
    }

    /**
     * The colour classes in one class list — a single quoted piece of source
     * with the quotes already off. The class list a tint and its own text share
     * is exactly this, which is why the walk is reachable on its own.
     */
    function classesIn(segment: string): string[] {
      return walk(segment);
    }

    /** The walk the two entry points share. */
    function walk(segment: string): string[] {
      const found: string[] = [];
      let i = 0;
      while (i < segment.length) {
        const axis = AXES.find(
          (a) => segment.startsWith(`${a}-`, i) && (i === 0 || !/[\w-]/.test(segment[i - 1])),
        );
        if (axis === undefined) {
          i++;
          continue;
        }
        let j = i + axis.length + 1;
        let value: string | null = null;
        if (segment[j] === "[") {
          let depth = 0;
          let k = j;
          while (k < segment.length) {
            if (segment[k] === "[") depth++;
            else if (segment[k] === "]" && --depth === 0) break;
            k++;
          }
          if (k >= segment.length) {
            i++;
            continue;
          }
          value = segment.slice(j, k + 1);
          j = k + 1;
        } else {
          const word = /^[a-z0-9-]+/.exec(segment.slice(j));
          if (word) {
            value = word[0];
            j += word[0].length;
          }
        }
        if (value === null || !COLOUR.test(value)) {
          i++;
          continue;
        }
        const alpha = /^\/(?:\[[^\]]+\]|[0-9.]+)/.exec(segment.slice(j));
        if (alpha) j += alpha[0].length;
        // A variant prefix is part of the selector Tailwind generates, so it
        // is part of the class name: `hover:bg-kin-red` is not `bg-kin-red`.
        let start = i;
        while (start > 0) {
          const prefix = /([a-z-]+:)$/.exec(segment.slice(0, start));
          if (
            !prefix ||
            (start > prefix[1].length && /[\w-]/.test(segment[start - prefix[1].length - 1]))
          ) {
            break;
          }
          start -= prefix[1].length;
        }
        found.push(segment.slice(start, i) + axis + "-" + value + (alpha?.[0] ?? ""));
        i = j;
      }
      return found;
    }

    /**
     * The selector Tailwind writes for a class name.
     *
     * Everything outside the word set is escaped with a backslash — except the
     * comma, which `tailwindcss/lib/util/escapeClassName` runs through
     * `postcss-selector-parser` and then rewrites as the hex escape `\2c `
     * (the space is part of it). So `bg-[rgba(255,69,58,.08)]` is written
     * `.bg-\[rgba\(255\2c 69\2c 58\2c \.08\)\]`. The first version of
     * `defines` spelled the comma `\,` and reported eight live classes in this
     * tree as missing, which is how the difference was found.
     */
    function selector(name: string): string {
      return "." + name.replace(/[^A-Za-z0-9_-]/g, (c) => (c === "," ? "\\2c " : `\\${c}`));
    }

    /**
     * Whether the built sheet defines this class.
     *
     * `css.includes(selector(name))` is a substring test, and the two ways it
     * passes something that is not there are both real: `.bg-kin-blue\/15`
     * contains `.bg-kin-blue`, and `.bg-kin-blue-ink` contains it too. So the
     * name has to be bounded by something that is not part of a class name.
     *
     * `\` counts as part of one rather than as a boundary: that is how Tailwind
     * writes the `/` of an opacity modifier, so an escape after the name means
     * the class name continues. A `.` in front of the name already rules out a
     * variant suffix — `hover:bg-kin-blue` is written `.hover\:bg-kin-blue:hover`,
     * and the escaped colon is not a dot.
     */
    function defines(css: string, name: string): boolean {
      const escaped = selector(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(?<![\\w\\\\-])${escaped}(?![\\w\\\\-])`).test(css);
    }

    it("generates CSS for every colour class in the tree", async () => {
      // The same file set Tailwind's `content` globs describe, built here as
      // absolute paths so the case does not depend on the working directory —
      // and without the tests, which do not render. `index.html` is in it
      // because `content` scans it: the shell paints `bg-kin-bg text-kin-text`
      // on `<body>` before any script runs, and that pair was outside every
      // guard while the filter named four extensions Tailwind does not care
      // about.
      const rendered = sourceFiles().filter(
        (f) => /\.(ts|tsx|js|jsx|html)$/.test(f) && !/\.test\./.test(f),
      );
      expect(rendered.length).toBeGreaterThan(100);
      const { css } = await postcss([
        tailwindcss({ ...config, content: rendered } as never),
      ]).process("@tailwind utilities;", { from: join(UI, "src/design/theme.css") });

      const bad: string[] = [];
      let total = 0;
      for (const file of rendered) {
        for (const name of candidates(readFileSync(file, "utf8"))) {
          total++;
          if (!defines(css, name)) bad.push(`${relative(UI, file)}: ${name}`);
        }
      }
      // A scan that found nothing would pass whatever the tree contained.
      // 2022 of them today, up from 1420 before the scanner below replaced the
      // quote-parity trick — the difference is class lists that were being read
      // as code and skipped.
      expect(total).toBeGreaterThan(1800);
      expect([...new Set(bad)].sort()).toEqual([]);
    });

    it("keeps a status tint that carries ink inside the ceiling", () => {
      // A tint is a composite, so the ceiling is where the inks drawn on one
      // were measured — `design/colors.ts` holds the number and the reasoning.
      // Above it a status colour is a solid rather than a wash, so a class list
      // may hold one or the other and nothing in between: that band is where a
      // 40% "selected" row was found putting its own `-ink` at 4.41:1.
      //
      // Nesting is invisible to a text scan. This reads the class list of one
      // element, which is where a tint and its own text sit; a tint on a parent
      // whose ink is in a child is covered by the measurement above instead.
      const family = TINTED_FILLS.join("|");
      const wash = new RegExp(`^(?:[a-z-]+:)*(?:bg|from|to|via)-(?:${family})/([0-9]+)$`);
      // The alpha is part of the class and therefore part of the regex. Without
      // it, an ink spelled with one — `text-kin-orange-ink/60` is real, on a
      // disabled submit — is not recognised as an ink at all, and a 60% wash
      // beside it goes unreported. The wash is what has a ceiling; an ink's own
      // alpha is the dimming a disabled control is allowed.
      const ink = new RegExp(
        `^(?:[a-z-]+:)*(?:text|placeholder)-(?:kin-(?:text|secondary|muted)|(?:${family})(?:-ink)?)(?:/(?:\\[[^\\]]+\\]|[0-9.]+))?$`,
      );
      const outside: string[] = [];
      for (const file of sourceFiles()) {
        for (const segment of strings(readFileSync(file, "utf8"))) {
          const classes = classesIn(segment);
          if (!classes.some((c) => ink.test(c))) continue;
          for (const name of classes) {
            const alpha = Number(wash.exec(name)?.[1]);
            if (alpha > TINT_CEILING && alpha < TINT_SOLID) {
              outside.push(`${relative(UI, file)}: ${name}`);
            }
          }
        }
      }
      expect(outside).toEqual([]);
    });

    it("never paints an ink as a background", () => {
      // Two tiers, two jobs: an `-ink` is a foreground that steps with the
      // scheme so text stays readable, a fill is the pigment that does not. A
      // dot painted with the ink is dark in the light scheme and pale in the
      // dark one — the opposite of the status family it is drawing.
      const ink = new RegExp(`^(?:[a-z-]+:)*bg-(?:${TINTED_FILLS.join("|")})-ink$`);
      const wrong: string[] = [];
      for (const file of sourceFiles()) {
        for (const name of candidates(readFileSync(file, "utf8"))) {
          if (ink.test(name)) wrong.push(`${relative(UI, file)}: ${name}`);
        }
      }
      expect(wrong).toEqual([]);
    });

    it("wears every elevation token as a class the ladder declares", () => {
      // A token is a colour and a `box-shadow` needs geometry too, so the
      // gallery cannot draw the token itself — the first version of that sample
      // set the colour alone and rendered `none` in both schemes, which is a
      // token that is declared, presented, measured, and drawn by nothing. The
      // pairing therefore lives in `ELEVATION_CLASS` beside the group, and this
      // holds it against the ladder in both directions.
      const tokens = TOKEN_GROUPS.filter((g) => g.kind === "elevation").flatMap((g) => [
        ...g.tokens,
      ]);
      expect(tokens.length).toBeGreaterThan(0);
      expect(Object.keys(ELEVATION_CLASS).sort()).toEqual([...tokens].sort());
      const offLadder = tokens.filter(
        (token) => theme.boxShadow[ELEVATION_CLASS[token].replace(/^shadow-/, "")] === undefined,
      );
      expect(offLadder).toEqual([]);
      // And the map is only half of it: the sample has to *wear* the class. A
      // guard that stopped at the map stayed green when the interpolation was
      // deleted from `DesignSystemPage.tsx` — which is the same shape as the
      // defect it was written for, one layer down (a token declared, presented,
      // measured, and drawn by nothing). The page is read as source, so the
      // template's `${…}` is part of the segment the scan sees.
      const page = readFileSync(join(UI, "src/pages/DesignSystemPage.tsx"), "utf8");
      // Anchored, because `includes("bg-kin-elevated")` is also true of
      // `bg-kin-elevated-panel` — a name that is not a token and emits no CSS,
      // so the loose test would have gone on passing while the sample wore
      // nothing. The colour-class case above would catch the bogus name; this
      // one should not need it to.
      const wearsClass = /(?<![\w-])bg-kin-elevated(?![\w-])/;
      const wears = strings(page).filter((s) => wearsClass.test(s));
      expect({
        wears: wears.length > 0,
        raises: wears.some((s) => s.includes("ELEVATION_CLASS")),
      }).toEqual({ wears: true, raises: true });
    });

    it("never draws a hairline on a static surface it also raises", () => {
      // S5's rule, in the one form a text scan can decide: two surfaces at
      // different levels are separated by the ladder and the drop, and a line
      // belongs to a boundary *inside* a level — so a surface already raised by
      // a step does not need one drawn as well, and a menu drawn with a 40px
      // blur and a 1px edge is a box drawn twice.
      //
      // What the case this replaced got wrong, and the reason for the word
      // *static*: a drop is not a level. `--kin-panel` is `--kin-bg` in the
      // light scheme (255 255 255, both L* 100), so a popover on a chat surface
      // has nothing to be separated *by* — and `e2`'s geometry (`0 8px 24px
      // -12px`) throws its drop below the element, painting no edge along the
      // top or the sides. Two of those lost their line to the first version of
      // this rule and were invisible in the light scheme until review found
      // them. So a *floating* element keeps its own edge, exactly as an input
      // keeps its own: it is the object's outline, not a level boundary. The
      // exemption is positional because the defect is, and a positioned class
      // is the one signal a class list carries about it.
      //
      // A status edge is neither case: `border-kin-blue/30` on a selected pill
      // is a state, and the rule leaves it alone.
      //
      // Assembled from the ladder: a guard that fails on its own source is a
      // guard nobody keeps, and this file is inside the tree being searched.
      const elevation = new RegExp(
        `(?<![\\w-])shadow-(?:${Object.keys(theme.boxShadow).join("|")})(?![\\w-])`,
      );
      const hairline =
        /border(?:-[trblxy])?(?:-kin-hairline(?:-strong)?|-\[var\(--kin-hairline(?:-strong)?\)\])/;
      // `z-*` is deliberately not in the list, though the rule this replaced
      // had it: a `z-index` alone does not take an element out of flow, so
      // exempting it exempted static cards that happened to stack. Only the
      // three positional values actually float.
      const floats = /(?<![\w-])(?:absolute|fixed|sticky)/;
      const both: string[] = [];
      for (const file of sourceFiles()) {
        const source = readFileSync(file, "utf8");
        // `strings()` reads quoted runs, and an `@apply` list in CSS is
        // unquoted — so the one file that composes a class list in the
        // stylesheet was a hole in a scan that believed it covered `.css`.
        const segments = strings(source);
        for (const [, applied] of source.matchAll(/@apply\s+([^;]+);/g)) segments.push(applied);
        for (const segment of segments) {
          if (elevation.test(segment) && hairline.test(segment) && !floats.test(segment)) {
            both.push(`${relative(UI, file)}: ${segment.trim().slice(0, 80)}`);
          }
        }
      }
      expect(both).toEqual([]);
    });

    it("puts the assigned foreground on every fill that carries one", () => {
      // A fill is a pigment that does not switch with the scheme, so it cannot
      // pick its own text — the pairs are assigned in `design/colors.ts` and
      // measured one describe block up. This is the other half: the call sites
      // have to use the assignment. Both classes exist and both render, so
      // near-white on the orange fill — 2.06:1 — is invisible to every other
      // case in this file.
      //
      // Only a fill that already carries one of the two foregrounds is checked.
      // Most solid fills in the tree are a dot, a bar or a border with no text on
      // them at all, and demanding one would be a rule the design does not have.
      //
      // The class list is the quoted run, as in the tint case above: that is one
      // `className`, and a fill and its own text are in the same one. A run the
      // scanner paired wrongly can hold two elements' classes, so this errs
      // towards reporting a pair that is not there — loudly, and with the file
      // named, which is the direction a guard should fail in.
      // The status fills are triplets, so the class name drops `-rgb` as well as
      // the `--kin-` prefix: `--kin-blue-rgb` is the class `bg-kin-blue`.
      const assigned = new Map(
        FILL_INK.map((p) => [
          p.fill.replace(/^--kin-/, "").replace(/-rgb$/, ""),
          p.ink.replace(/^--kin-/, ""),
        ]),
      );
      const solid = new RegExp(`^(?:[a-z-]+:)*bg-kin-(${[...assigned.keys()].join("|")})$`);
      const foreground = /^(?:[a-z-]+:)*text-kin-on-(?:status|brand)$/;
      const wrong: string[] = [];
      let pairs = 0;
      for (const file of sourceFiles()) {
        for (const segment of strings(readFileSync(file, "utf8"))) {
          const classes = classesIn(segment);
          for (const name of classes) {
            const family = solid.exec(name)?.[1];
            if (family === undefined) continue;
            const expected = `text-kin-${assigned.get(family)}`;
            for (const other of classes) {
              if (!foreground.test(other)) continue;
              pairs++;
              if (other.replace(/^[a-z-]+:/, "") !== expected) {
                wrong.push(`${relative(UI, file)}: ${name} + ${other}`);
              }
            }
          }
        }
      }
      expect(wrong).toEqual([]);
      // The tree has 40 of these today; a scan that stopped finding them would
      // pass whatever the call sites did next.
      expect(pairs).toBeGreaterThan(32);
    });

    it("writes the theme-color meta from the token, not from a literal", () => {
      // The colour a phone paints its own chrome with. `content` takes no
      // `var()`, so this is the one place a colour could escape the token layer;
      // it is checked as text because jsdom resolves no custom property out of a
      // stylesheet, and asserted against the *dark* page because that is what
      // the static HTML is read with, before any script runs.
      const html = readFileSync(join(UI, "index.html"), "utf8");
      const metas = [...html.matchAll(/<meta name="theme-color" content="([^"]+)"/g)];
      expect(metas.map(([, value]) => value)).toEqual([DARK["--kin-page"]]);
      // Comments go first: a call written in a comment is not a call, and the
      // mutation that proves this case works is exactly that.
      const theme = readFileSync(join(UI, "src/lib/theme.ts"), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      const apply = /export function applyTheme\b[\s\S]*?\n}/.exec(theme)?.[0] ?? "";
      const setAttribute = apply.indexOf('setAttribute("data-theme"');
      const applyColor = apply.indexOf("applyThemeColor()");
      // The order is the point, not the presence: the meta is read back out of
      // the computed style, so a call above the attribute write would publish
      // the *previous* scheme's backdrop — and the value it publishes is the
      // phone's own chrome, which is the one surface that has no other chance to
      // be right.
      expect({ wroteScheme: setAttribute >= 0, thenRead: applyColor > setAttribute }).toEqual({
        wroteScheme: true,
        thenRead: true,
      });
    });
  });
});
