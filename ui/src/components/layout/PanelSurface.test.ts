import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * There is one full-bleed session surface, and this is the test that keeps it one.
 *
 * Five of them used to be five hand-copied strings — `absolute inset-0 z-40`, the
 * same background, the same `safe-pad` — at the same z-index, with no single
 * answer to "which one is on top". Two of them had different owners that did not
 * know about each other. The registry (see `lib/panels.ts`) makes "which one is
 * open" a single value; this makes "what a surface is" a single string, and it is
 * the half a compiler cannot check: nothing stops the next panel from writing the
 * classes out again, and the symptom is a panel that renders *underneath* another
 * one, with its own close button unreachable.
 *
 * The scan is over source rather than DOM for the same reason
 * `design/tokens.test.ts` is — the tree has no DOM test environment by design,
 * and this is a property of the source text. It reads the file with the
 * TypeScript parser instead of a pattern: the first draft of this guard used a
 * regex over quoted text and desynchronised on its own regex literals, then
 * reported a stretch of code as a class list. A guard nobody can trust is worse
 * than the missing guard, so the parser is worth the import.
 */
// `ui/` — three levels up from this file, which sits at `ui/src/components/layout`.
const UI = fileURLToPath(new URL("../../..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "dist"]);

/**
 * Files allowed to spell out a full-bleed overlay, and why.
 *
 * An allow-list rather than a pattern, because the list *is* the decision: adding
 * a surface is fine, doing it without saying so here is not. The two mobile
 * drawers are a different thing from a surface over the session — they cover the
 * whole viewport, not the app frame — but they are written with the same classes,
 * so they are named rather than pattern-matched away.
 */
const ALLOWED = new Map([
  ["src/components/layout/PanelSurface.tsx", "the one session surface"],
  ["src/components/layout/Sidebar.tsx", "mobile navigation drawer, over the whole viewport"],
  ["src/pages/NewChatPage.tsx", "mobile sheet, over the whole viewport"],
]);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (!SKIP_DIRS.has(entry)) walk(full);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(join(UI, "src"));
  return out;
}

/** Every string in a file, as the parser sees them — comments are not strings. */
function stringsIn(source: string, fileName: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  return out;
}

/** A string that is a full-bleed surface: it says both where and how high. */
function isSurface(classes: string): boolean {
  return /(^|\s)inset-0(\s|$)/.test(classes) && /(^|\s)z-40(\s|$)/.test(classes);
}

describe("PanelSurface", () => {
  it("is the only place a full-bleed surface is spelled out", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const rel = relative(UI, file);
      if (ALLOWED.has(rel)) continue;
      if (stringsIn(readFileSync(file, "utf8"), file).some(isSurface)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("still allows the ones it names, so the list cannot rot", () => {
    // A stale entry is a hole: the file could grow a second surface and this
    // guard would keep waving it through.
    const stale = [...ALLOWED.keys()].filter((rel) => {
      let source: string;
      try {
        source = readFileSync(join(UI, rel), "utf8");
      } catch {
        return true;
      }
      return !stringsIn(source, rel).some(isSurface);
    });
    expect(stale).toEqual([]);
  });
});
