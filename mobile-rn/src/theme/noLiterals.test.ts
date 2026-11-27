import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "@jest/globals";

/**
 * KIN-MOBILE-002 R1b — the guard that stops a colour literal coming back.
 *
 * `tokens.ts` is the one file allowed to spell a palette value; every screen
 * and app file paints through `useTheme()` instead. A colour counts only when
 * it is the whole content of a quoted string, so prose that mentions an issue
 * number (`ConversationView.tsx`'s `#779` comment) is not a colour.
 *
 * `"transparent"` is deliberately not a colour here: it is the absence of a
 * fill, and both glass surfaces depend on it to keep the blur showing.
 */

const MOBILE_ROOT = path.resolve(__dirname, "../..");

/** The colour spellings this guard treats as a literal. */
const COLOUR =
  /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$|^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/;

/** A quoted string whose whole content is a colour, in any quote style. */
const QUOTED_COLOUR = /(["'`])([^"'`]*)\1/g;

export type Hit = { file: string; line: number; value: string };

/** Paths are relative to `mobile-rn/`, with `/` separators on every platform. */
export function scanned(relativePath: string): boolean {
  const normal = relativePath.split(path.sep).join("/");
  if (!/\.(ts|tsx)$/.test(normal)) return false;
  // The token module is where the palette is written; tests may spell
  // fixtures (the positive control below is one).
  if (normal.startsWith("src/theme/")) return false;
  if (/\.test\./.test(normal)) return false;
  return true;
}

function walk(dir: string, found: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, found);
      continue;
    }
    found.push(full);
  }
  return found;
}

/** Every colour literal in one file's text, with its 1-based line. */
export function scanText(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  for (const match of text.matchAll(QUOTED_COLOUR)) {
    if (!COLOUR.test(match[2]!)) continue;
    const before = text.slice(0, match.index ?? 0);
    hits.push({
      file,
      line: before.split("\n").length,
      value: match[2]!,
    });
  }
  return hits;
}

/** Every colour literal under `src/` and `app/`, excluding the token module. */
export function scan(root: string = MOBILE_ROOT): Hit[] {
  const files = [
    ...walk(path.join(root, "src")),
    ...walk(path.join(root, "app")),
  ];
  return files.flatMap((full) => {
    const relative = path.relative(root, full);
    if (!scanned(relative)) return [];
    return scanText(relative, fs.readFileSync(full, "utf8"));
  });
}

describe("KIN-MOBILE-002 R1b colour literal guard", () => {
  it("KIN-MOBILE-002 R1b: no screen or app file spells a colour", () => {
    const hits = scan();
    const listed = hits
      .map((hit) => `${hit.file}:${hit.line} ${hit.value}`)
      .join("\n");
    // The failure message is the work list: every file, line and value.
    expect({ count: hits.length, hits: listed }).toEqual({
      count: 0,
      hits: "",
    });
  });

  it("KIN-MOBILE-002 R1b: the scanner catches a colour in a style object", () => {
    // A positive control: a scanner that always answers [] must not pass.
    const fixture = [
      "const styles = StyleSheet.create({",
      '  row: { backgroundColor: "#1d1d1d" },',
      "});",
    ].join("\n");
    expect(scanText("src/screens/fixture.tsx", fixture)).toEqual([
      { file: "src/screens/fixture.tsx", line: 2, value: "#1d1d1d" },
    ]);
  });

  it("KIN-MOBILE-002 R1b: an issue reference in a comment is not a colour", () => {
    const comment =
      " * an open round belongs to the thinking row (#779, TASTE 15), and";
    expect(scanText("src/screens/fixture.tsx", comment)).toEqual([]);
  });

  it("KIN-MOBILE-002 R1b: the token module is the one file allowed to spell the palette", () => {
    expect(scanned("src/theme/tokens.ts")).toBe(false);
    expect(scanned("src/screens/ConversationList.tsx")).toBe(true);
  });
});
