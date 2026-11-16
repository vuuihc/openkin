import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_LANG_TAG, DEFAULT_LOCALE, en, zh } from "./index";
import { AUTH_ERROR_CODES } from "../lib/accountGate";

/**
 * Every path in one catalog, so the two can be compared.
 *
 * A locale is only as good as its completeness: a key that exists in one
 * language and not the other is a line of the UI that reads as a dotted path.
 * `t()` hides that — it falls back to the path string — so a test that calls
 * `t()` cannot see it.
 */
function paths(tree: unknown, prefix = ""): string[] {
  if (tree === null || typeof tree !== "object") return [prefix];
  const out: string[] = [];
  for (const [key, value] of Object.entries(tree as Record<string, unknown>)) {
    out.push(...paths(value, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

describe("locale catalogs", () => {
  it("have the same keys in both languages", () => {
    const zhPaths = paths(zh).sort();
    const enPaths = paths(en).sort();
    expect(enPaths.filter((p) => !zhPaths.includes(p))).toEqual([]);
    expect(zhPaths.filter((p) => !enPaths.includes(p))).toEqual([]);
  });

  it("translate every key to something other than nothing", () => {
    // A blank string is the same bug as a missing one, one step later: the row
    // is there and says nothing.
    for (const [name, catalog] of [
      ["zh", zh],
      ["en", en],
    ] as const) {
      const blank = paths(catalog).filter((path) => {
        let cur: unknown = catalog;
        for (const part of path.split(".")) {
          cur = (cur as Record<string, unknown>)[part];
        }
        return typeof cur !== "string" || cur.trim() === "";
      });
      expect({ locale: name, blank }).toEqual({ locale: name, blank: [] });
    }
  });

  it("use the same placeholders in both languages", () => {
    // Key parity cannot see this one: a template translated with a renamed
    // placeholder (`{stat}`) has a row in both catalogs and renders the braces
    // literally, because `t()` only replaces the names it is given.
    const leaves = (tree: unknown, prefix = ""): Array<[string, string]> => {
      if (typeof tree === "string") return [[prefix, tree]];
      if (tree === null || typeof tree !== "object") return [];
      return Object.entries(tree as Record<string, unknown>).flatMap(([key, value]) =>
        leaves(value, prefix ? `${prefix}.${key}` : key),
      );
    };
    const tokens = (value: string) =>
      [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    const zhLeaves = new Map(leaves(zh));
    const mismatched = leaves(en)
      .filter(([path, value]) => {
        const other = zhLeaves.get(path);
        // A key missing from zh is the test above's finding, not this one's.
        if (other === undefined) return false;
        return tokens(value).join(",") !== tokens(other).join(",");
      })
      .map(([path]) => path);
    expect(mismatched).toEqual([]);
  });

  it("translate every auth error code the Hub can send", () => {
    // The key-parity tests above only compare the two catalogs to each other, so
    // a code that is in neither -- because Go learned a new one and the console
    // did not -- passes both. This is the other direction: every code in the
    // union has a row in both languages. Missing one is quiet rather than loud,
    // because `authErrorText` falls back to the server's English prose.
    for (const code of AUTH_ERROR_CODES) {
      expect({ code, en: en.account.errors[code] }).toEqual({
        code,
        en: expect.any(String),
      });
      expect({ code, zh: zh.account.errors[code] }).toEqual({
        code,
        zh: expect.any(String),
      });
    }
  });
});

/**
 * Chinese text has its own punctuation, and the console was written with the
 * English kind: an ASCII colon between a label and its value, and three ASCII
 * dots for an ellipsis. Both are visible — a fullwidth colon carries its own
 * right-hand spacing, and `…` is one glyph wide where `...` is three — and both
 * were being spent one call site at a time in JSX, where no locale file could
 * fix them.
 *
 * The separator is the mechanical half: a label/value pair says
 * `common.labelSeparator` and each locale decides what that is. The catalogue
 * half checks the strings themselves.
 */
describe("locale typography", () => {
  /** Every string leaf of a catalogue, with its dotted path. */
  function strings(tree: unknown, prefix = ""): Array<[string, string]> {
    if (typeof tree === "string") return [[prefix, tree]];
    if (tree === null || typeof tree !== "object") return [];
    return Object.entries(tree as Record<string, unknown>).flatMap(([key, value]) =>
      strings(value, prefix ? `${prefix}.${key}` : key),
    );
  }

  it("never spells an ellipsis with three ASCII dots", () => {
    for (const [name, catalog] of [
      ["zh", zh],
      ["en", en],
    ] as const) {
      const dotted = strings(catalog)
        .filter(([, value]) => value.includes("..."))
        .map(([path]) => path);
      expect({ locale: name, dotted }).toEqual({ locale: name, dotted: [] });
    }
  });

  it("owns the label separator, and gives each language its own", () => {
    // The fullwidth colon for Chinese, `": "` for English. If these ever match,
    // one of the two languages is being rendered with the other's punctuation.
    expect(zh.common.labelSeparator).toBe("：");
    expect(en.common.labelSeparator).toBe(": ");
  });

  it("declares the default language in index.html", () => {
    // Before any script runs — the first paint, and anything that reads the
    // document rather than the app. The build copies this file, so a template
    // that says `en` renders a Chinese page in Japanese glyph forms. The
    // running document is `documentLang.dom.test.ts`'s subject.
    const html = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");
    expect(html).toContain(`<html lang="${DEFAULT_LANG_TAG}"`);
    expect(DEFAULT_LOCALE).toBe("zh");
  });
});
