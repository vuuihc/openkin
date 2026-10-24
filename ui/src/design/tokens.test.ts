import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
const SKIP_DIRS = new Set(["node_modules", "generated", "dist"]);

function sourceFiles(dir = join(UI, "src")): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx|css)$/.test(entry)) {
      out.push(full);
    }
  }
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
        for (const surface of ["--kin-bg", "--kin-elevated", "--kin-panel", "--kin-sidebar"]) {
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
    const leftovers: string[] = [];
    const old = /text-(?:\[[0-9.]+px\]|xs|sm|base|lg|xl|2xl|3xl|4xl)(?![\w-])/g;
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
});
