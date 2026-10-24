import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import resolveConfig from "tailwindcss/resolveConfig";
import { describe, expect, it } from "vitest";
import config from "../../tailwind.config.ts";
import { PRESENTED_TOKENS } from "../pages/DesignSystemPage";
import { ROLE_PREVIEW, TYPE_ROLES, WEIGHT_CLASS } from "./type";

/**
 * The design layer's own consistency: the colour tokens and the type ladder.
 *
 * Everything here is a property of two files and the code between them, so it
 * needs no browser: `design/theme.css` declares, `design/type.ts` names the
 * sizes, components reference, and these tests are the only thing that has ever
 * compared them. Before them, four references pointed at names that were never
 * defined and nothing noticed — a panel width built from `--kin-ws-sidebar`
 * silently became `auto`, and a checkbox's accent built from `--kin-blue` did
 * nothing at all.
 *
 * (This comment names tokens without the `var(` in front of them on purpose:
 * the reference scan reads this file too, and a mention in prose is not a use.)
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

/** The `:root` blocks of the token layer, in file order (dark, then light). */
function schemeBlocks(): { scheme: "dark" | "light"; tokens: Record<string, string> }[] {
  const css = readFileSync(join(UI, "src/design/theme.css"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  const blocks: { scheme: "dark" | "light"; tokens: Record<string, string> }[] = [];
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const tokens: Record<string, string> = {};
    for (const [, name, value] of body.matchAll(/(--kin-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      tokens[name] = value.trim();
    }
    if (Object.keys(tokens).length === 0) continue;
    blocks.push({ scheme: selector.includes("light") ? "light" : "dark", tokens });
  }
  return blocks;
}

const BLOCKS = schemeBlocks();
const DARK = BLOCKS.find((b) => b.scheme === "dark")?.tokens ?? {};
const LIGHT = BLOCKS.find((b) => b.scheme === "light")?.tokens ?? {};

type RGB = [number, number, number];

function rgb(value: string, where: string): RGB {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!hex) {
    throw new Error(`${where} is ${value}, and this check needs an opaque #rrggbb to measure`);
  }
  const n = parseInt(hex[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
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
  it("has one dark block and one light block, and no others", () => {
    expect(BLOCKS.map((b) => b.scheme)).toEqual(["dark", "light"]);
  });

  it("declares the same names in both schemes", () => {
    const dark = Object.keys(DARK).sort();
    const light = Object.keys(LIGHT).sort();
    // A token defined for one scheme only is invisible in the other: it either
    // falls back to nothing (transparent) or keeps the other scheme's value.
    expect(light.filter((n) => !dark.includes(n))).toEqual([]);
    expect(dark.filter((n) => !light.includes(n))).toEqual([]);
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

  it("keeps every surface far enough from --kin-bg to be seen without a border", () => {
    for (const [scheme, tokens] of [
      ["dark", DARK],
      ["light", LIGHT],
    ] as const) {
      const base = lightness(rgb(tokens["--kin-bg"], `${scheme} --kin-bg`));
      // `panel` is exempt: a sheet is separated from what is behind it by its
      // scrim, not by its own lightness, and in light mode it is deliberately
      // the same white as the content it covers.
      for (const name of ["--kin-page", "--kin-sidebar", "--kin-inspector", "--kin-elevated"]) {
        const delta = Math.abs(lightness(rgb(tokens[name], `${scheme} ${name}`)) - base);
        expect({ scheme, name, atLeast2L: delta >= 2 }).toEqual({ scheme, name, atLeast2L: true });
      }
    }
  });

  it("keeps every ink step above 4.5:1 on the surfaces it is drawn on", () => {
    for (const [scheme, tokens] of [
      ["dark", DARK],
      ["light", LIGHT],
    ] as const) {
      for (const ink of ["--kin-text", "--kin-secondary", "--kin-muted"]) {
        for (const surface of [
          "--kin-bg",
          "--kin-elevated",
          "--kin-panel",
          "--kin-sidebar",
          // The workspace panel is a real ink surface (`index.css` paints it),
          // and `theme.css` even quotes its number for the ring. It passes for
          // ink today; it is here so that tuning a value cannot regress it
          // unseen.
          "--kin-inspector",
        ]) {
          const ratio = contrast(rgb(tokens[ink], ink), rgb(tokens[surface], surface));
          expect({ scheme, ink, surface, passes: ratio >= 4.5 }).toEqual({
            scheme,
            ink,
            surface,
            passes: true,
          });
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
      expect(DARK[`--kin-${role.ink}`]).toBeDefined();
    }
  });

  it("keeps the focus ring measurable on every surface a control is focused on", () => {
    // WCAG 1.4.11: a non-text indicator needs 3:1. What the 16 sites carried
    // before was brand blue — 11 of them at 40–50% alpha, which managed 1.7:1
    // on the surface a focused control actually sits on, and 5 opaque, which is
    // 2.57:1 on the light page. So the old ring got two things wrong: alpha,
    // and one blue for two themes. `rgb()` refusing a non-opaque value is part
    // of the guard, not a limitation of it.
    //
    // `--kin-page` is in the list because it is the worst case, not because a
    // control usually sits there: the mobile tab bar and the sheet scrims are
    // drawn on it, and it is what forced the light value below brand blue.
    for (const [scheme, tokens] of [
      ["dark", DARK],
      ["light", LIGHT],
    ] as const) {
      for (const surface of [
        "--kin-page",
        "--kin-bg",
        "--kin-elevated",
        "--kin-panel",
        "--kin-sidebar",
        "--kin-inspector",
      ]) {
        const ratio = contrast(
          rgb(tokens["--kin-focus-ring"], `${scheme} --kin-focus-ring`),
          rgb(tokens[surface], `${scheme} ${surface}`),
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
    // 2.57:1 on the light page, well under 3:1. Five sites did exactly that,
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

    it("does not spell out a layout value the ladder already names", () => {
      // The four arbitrary values the layout names replaced. Assembled from
      // their prefixes: this file is inside the tree being searched, and a
      // guard that fails on its own source is a guard nobody keeps.
      const renamed = [
        ["w-", "[248px]", "w-sidebar"],
        ["max-w-", "[720px]", "max-w-conversation"],
        ["max-w-", "[min(100%,420px)]", "max-w-sheet"],
        ["max-w-", "[min(40%,18rem)]", "max-w-inspector"],
      ];
      const bad: string[] = [];
      for (const file of sourceFiles()) {
        const source = readFileSync(file, "utf8");
        for (const [axis, value, name] of renamed) {
          if (source.includes(axis + value))
            bad.push(`${relative(UI, file)}: ${axis + value} → ${name}`);
        }
      }
      expect(bad).toEqual([]);
    });
  });
});
