import { describe, expect, it } from "vitest";
import { en, zh } from "./index";

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
});
