import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRESENTED_TOKENS } from "../pages/DesignSystemPage";

/**
 * The token layer's own consistency.
 *
 * Everything here is a property of two files and the code between them, so it
 * needs no browser: `design/theme.css` declares, components reference, and
 * these tests are the only thing that has ever compared the two. Before them,
 * four references pointed at names that were never defined and nothing
 * noticed — a panel width built from `--kin-ws-sidebar` silently became `auto`,
 * and a checkbox's accent built from `--kin-blue` did nothing at all.
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
    const files = [...sourceFiles(), join(UI, "tailwind.config.js")];
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
});
