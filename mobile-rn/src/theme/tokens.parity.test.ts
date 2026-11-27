import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "@jest/globals";
import { palette, type Palette, type Scheme } from "./tokens";

/**
 * KIN-MOBILE-002 R1a — the RN palette against the desktop's token layer.
 *
 * `ui/src/design/theme.css` is the source of truth for every colour the two
 * clients paint, so the port is checked by reading that file from disk rather
 * than by trusting a copy of its values. Three declaration blocks become two
 * schemes: the shared one (the agents' identity marks, the same in both) is
 * folded into each, then the bare `:root` block is dark and the light-selector
 * block is light — the same resolution `ui/src/design/tokens.test.ts` uses.
 *
 * A channel triplet (`44 44 46`) is a web implementation detail — it exists so
 * Tailwind can put an opacity modifier on the value — so the RN port spells it
 * `rgb(44, 44, 46)`. Everything else keeps theme.css's spelling.
 */

const THEME_CSS = path.resolve(__dirname, "../../../ui/src/design/theme.css");
const CSS = fs.readFileSync(THEME_CSS, "utf8");

type Blocks = Record<"shared" | Scheme, Record<string, string>>;

/** The `--kin-*` blocks of theme.css, with comments removed first. */
function parse(css: string): Blocks {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: Blocks = { shared: {}, dark: {}, light: {} };
  for (const [, selector, body] of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declared: Record<string, string> = {};
    for (const [, name, value] of body.matchAll(/(--kin-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      declared[name] = value.trim();
    }
    if (Object.keys(declared).length === 0) continue;
    const parts = selector.split(",").map((s) => s.trim());
    const light = parts.some((s) => s.includes("light"));
    // The shared block names the light scheme *and* the root element; the dark
    // block is a bare `:root`. A selector cannot be classified on the word
    // "light" alone.
    const shared = light && parts.some((s) => s === ":root");
    Object.assign(blocks[shared ? "shared" : light ? "light" : "dark"], declared);
  }
  return blocks;
}

/** `--kin-hairline-strong` → `hairlineStrong`, with `-rgb` dropped. */
function key(name: string): string {
  return name
    .replace(/^--kin-/, "")
    .replace(/-rgb$/, "")
    .replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * A theme.css value as RN will draw it. Unknown spellings throw: a new kind of
 * value on the web side must fail here, not compare equal by accident.
 */
function canonical(value: string): string {
  const v = value.trim();
  const triplet = /^(\d{1,3}) (\d{1,3}) (\d{1,3})$/.exec(v);
  if (triplet) return `rgb(${triplet[1]}, ${triplet[2]}, ${triplet[3]})`;
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) return `#${hex[1].toLowerCase()}`;
  const rgba = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/.exec(v);
  if (rgba) return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, ${rgba[4]})`;
  throw new Error(`theme.css declares ${value}, which this port does not understand`);
}

/**
 * Every difference between one scheme as theme.css resolves it and its port.
 *
 * Returned rather than asserted so the "changed web value" case can run the
 * same comparison against a mutated copy of the stylesheet and prove it
 * reports the change.
 */
function differences(css: string, scheme: Scheme, port: Palette): string[] {
  const blocks = parse(css);
  const resolved = { ...blocks.shared, ...blocks[scheme] };
  const expected = new Map<string, string>();
  for (const [name, value] of Object.entries(resolved)) {
    expected.set(key(name), canonical(value));
  }
  const actual = port as unknown as Record<string, string>;
  const out: string[] = [];
  for (const [name, value] of expected) {
    if (!(name in actual)) out.push(`${scheme}: ${name} is missing`);
    else if (actual[name] !== value) {
      out.push(`${scheme}: ${name} is ${actual[name]}, theme.css says ${value}`);
    }
  }
  for (const name of Object.keys(actual)) {
    if (!expected.has(name)) out.push(`${scheme}: ${name} is not declared by theme.css`);
  }
  return out;
}

describe("KIN-MOBILE-002 R1a token parity", () => {
  it("KIN-MOBILE-002 R1a parity: the light palette equals theme.css", () => {
    expect(differences(CSS, "light", palette.light)).toEqual([]);
  });

  it("KIN-MOBILE-002 R1a parity: the dark palette equals theme.css", () => {
    expect(differences(CSS, "dark", palette.dark)).toEqual([]);
  });

  it("KIN-MOBILE-002 R1a parity: every colour theme.css declares is ported", () => {
    // Names, not values: the two cases above compare values for the tokens they
    // know, and this is what makes a *new* web token fail until it is ported.
    const stripped = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
    const names = [...new Set([...stripped.matchAll(/(--kin-[a-z0-9-]+)\s*:/g)].map((m) => key(m[1])))];
    // A scan that matched nothing would pass whatever the file contained.
    expect(names.length).toBeGreaterThan(30);
    for (const name of names) {
      expect({ name, light: name in palette.light, dark: name in palette.dark }).toEqual({
        name,
        light: true,
        dark: true,
      });
    }
  });

  it("KIN-MOBILE-002 R1a parity: a changed web value makes the RN palette red", () => {
    // The proof that the cases above read the file rather than a copy of it:
    // mutate the stylesheet in memory and the same comparison must report the
    // token. The file on disk is never written.
    const current = "--kin-bg: #1a1a1c;";
    expect(CSS).toContain(current);
    const altered = CSS.replace(current, "--kin-bg: #1a1a1d;");
    expect(altered).not.toBe(CSS);
    expect(differences(altered, "dark", palette.dark)).toEqual([
      "dark: bg is #1a1a1c, theme.css says #1a1a1d",
    ]);
    // The other scheme is untouched by a dark-block edit, which is what makes
    // the light case above its own check rather than a second reading of this one.
    expect(differences(altered, "light", palette.light)).toEqual([]);
  });

  it("KIN-MOBILE-002 R1a parity: both schemes declare the same names", () => {
    const blocks = parse(CSS);
    const shared = Object.keys(blocks.shared);
    const light = [...shared, ...Object.keys(blocks.light)].sort();
    const dark = [...shared, ...Object.keys(blocks.dark)].sort();
    expect(shared.length).toBeGreaterThan(0);
    expect(light).toEqual(dark);

    // And the port: a key in one scheme and not the other would render as
    // whatever the missing lookup returned.
    expect(Object.keys(palette.light).sort()).toEqual(Object.keys(palette.dark).sort());

    // The shared block is deliberately scheme-independent: an agent's identity
    // mark that changed with the lights would be a worse mark, not a themed one.
    const agents = shared.map((name) => key(name));
    expect(agents.length).toBe(7);
    for (const name of agents) {
      expect({
        name,
        same: (palette.light as unknown as Record<string, string>)[name] ===
          (palette.dark as unknown as Record<string, string>)[name],
      }).toEqual({ name, same: true });
    }
  });
});
