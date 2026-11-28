import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "@jest/globals";
import { en, zh } from "./i18n";

/**
 * KIN-MOBILE-002 R6 — the guard that keeps every phone `t("…")` key in the catalog.
 *
 * `mobile-rn/src/i18n.ts` returns the path itself on a miss
 * (`lookup(catalog, path) ?? lookup(catalogs.zh, path) ?? path`), so a key the
 * catalogs do not carry does not crash: it prints `progress.input` in the
 * middle of a sentence. The usage sheet did exactly that
 * (`ProviderUsage.tsx:159,161` asked for `progress.input` / `progress.output`
 * while the shared catalog keeps them under `chat.progress.*`), and no test
 * could see it because a fixture `t` echoes whatever it is handed.
 *
 * This suite scans the source instead: every literal key under `src/` and
 * `app/` must resolve in **both** catalogs (TASTE 10 — zh and en are one
 * contract). Non-literal calls (`t(WINDOW_LABEL_KEYS[days])`) and a local
 * helper whose name merely ends in `t` (`realT("…")`) are not literals the
 * adapter would look up, so the scanner ignores them; the positive control
 * below proves the scanner is not vacuously empty.
 */

const MOBILE_ROOT = path.resolve(__dirname, "..");

/** A literal `t("…")` key and the 1-based line it is asked on. */
export type Asked = { line: number; key: string };

export type Missing = Asked & { file: string };

/**
 * Every literal `t("…")` call in one file's text.
 *
 * The lookbehind keeps `realT(` and `x.t(` out: only a bare `t(` is the
 * adapter call. `\s` spans newlines, so a call broken across lines is still
 * one key.
 */
const LITERAL_T = /(?<![\w.])t\(\s*"([^"]+)"/g;

export function keysIn(text: string): Asked[] {
  const asks: Asked[] = [];
  for (const match of text.matchAll(LITERAL_T)) {
    asks.push({
      line: text.slice(0, match.index ?? 0).split("\n").length,
      key: match[1]!,
    });
  }
  return asks;
}

/**
 * The adapter's own dot-path rule (`mobile-rn/src/i18n.ts:58-66`): walk the
 * object one segment at a time and accept only a string leaf.
 */
export function resolves(tree: unknown, key: string): string | undefined {
  let current: unknown = tree;
  for (const part of key.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

/** Paths are relative to `mobile-rn/`, with `/` separators on every platform. */
export function scanned(relativePath: string): boolean {
  const normal = relativePath.split(path.sep).join("/");
  if (!/\.(ts|tsx)$/.test(normal)) return false;
  if (/\.(test|spec|mutants)\./.test(normal)) return false;
  if (normal.split("/").includes("node_modules")) return false;
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

/** Every asked key one or both catalogs cannot answer, with its file and line. */
export function missingKeys(root: string = MOBILE_ROOT): Missing[] {
  const files = [
    ...walk(path.join(root, "src")),
    ...walk(path.join(root, "app")),
  ];
  return files.flatMap((full) => {
    const relative = path.relative(root, full).split(path.sep).join("/");
    if (!scanned(relative)) return [];
    return keysIn(fs.readFileSync(full, "utf8"))
      .filter(
        (ask) =>
          resolves(zh, ask.key) === undefined ||
          resolves(en, ask.key) === undefined,
      )
      .map((ask) => ({ file: relative, ...ask }));
  });
}

describe("KIN-MOBILE-002 R6 phone i18n key contract", () => {
  it("KIN-MOBILE-002 R6: every t() key the phone source asks for exists in both catalogs", () => {
    const missing = missingKeys();
    // The failure message is the work list: every file, line and key.
    const listed = missing
      .map((hit) => `${hit.file}:${hit.line} ${hit.key}`)
      .join("\n");
    expect({ count: missing.length, hits: listed }).toEqual({
      count: 0,
      hits: "",
    });
  });

  it("KIN-MOBILE-002 R6: the scanner extracts a literal key and resolves it in both catalogs", () => {
    // A positive control: a scanner that always answers [] must not pass.
    expect(keysIn('const label = t("chat.progress.input");')).toEqual([
      { line: 1, key: "chat.progress.input" },
    ]);
    expect(keysIn('t(\n  "chat.progress.output",\n)')).toEqual([
      { line: 1, key: "chat.progress.output" },
    ]);
    expect(resolves(zh, "chat.progress.input")).toBe("输入");
    expect(resolves(en, "chat.progress.input")).toBe("Input");

    // The bare path `ProviderUsage.tsx` used to ask for is in neither catalog:
    // it is the miss the sheet printed, not a key some other block carries.
    expect(resolves(zh, "progress.input")).toBeUndefined();
    expect(resolves(en, "progress.input")).toBeUndefined();
  });

  it("KIN-MOBILE-002 R6: non-literal calls and lookalike helpers are not keys", () => {
    expect(keysIn("const label = t(WINDOW_LABEL_KEYS[days]);")).toEqual([]);
    expect(keysIn('const label = realT("chat.progress.input");')).toEqual([]);
    expect(keysIn('const label = screen.t("chat.progress.input");')).toEqual([]);
  });

  it("KIN-MOBILE-002 R6: test files and non-source paths stay outside the scan", () => {
    expect(scanned("src/screens/ProviderUsage.tsx")).toBe(true);
    expect(scanned("app/index.tsx")).toBe(true);
    expect(scanned("src/screens/ProviderUsage.test.tsx")).toBe(false);
    expect(scanned("src/screens/ProviderUsage.visual.test.tsx")).toBe(false);
    expect(scanned("src/screens/ProviderUsage.visual.mutants.json")).toBe(false);
    expect(scanned("src/i18n.keys.test.ts")).toBe(false);
    expect(scanned("node_modules/expo/index.ts")).toBe(false);
  });
});
