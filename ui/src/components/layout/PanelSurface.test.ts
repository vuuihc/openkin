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
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry) && !/\.test\./.test(entry)) {
        // Test files are out of scope, as they are for the two project rules in
        // `eslint.config.js` and for `zen.test.ts`: a guard that asserts *about*
        // a shape has to spell the shape, and this one spells a surface out
        // three times over to prove it can see the spellings.
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

/**
 * The class lists a file assembles, one string per way it spells one.
 *
 * A surface is not always one string literal. `["absolute","inset-0","z-40"].join(" ")`
 * and `` `absolute inset-0 z-${40}` `` are the same classes spelled across several
 * nodes, and the first draft of this guard — which collected whole strings and
 * asked each one on its own — walked straight past both. So a `className`
 * expression is flattened into the class lists it can evaluate to:
 *
 * - a literal, or a template whose substitutions are literals, is one list;
 * - an array of literals is one list, joined the way the array is (`Tailwind`
 *   reads the joined string, and so does the caller's `.join(" ")`);
 * - anything else — a ternary, a call, a variable — contributes its branches
 *   *separately*, because two arms of a conditional are never both present and
 *   joining them would invent classes that no element ever carries.
 */
function classListsIn(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const literal = (node: ts.Node): string | null => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isNumericLiteral(node)) return node.text;
    return null;
  };
  const lists = (node: ts.Node): string[] => {
    const text = literal(node);
    if (text !== null) return [text];
    if (ts.isTemplateExpression(node)) {
      const spans = node.templateSpans.map(
        (span) => (literal(span.expression) ?? "") + span.literal.text,
      );
      return [node.head.text + spans.join("")];
    }
    if (ts.isArrayLiteralExpression(node)) {
      const elements = node.elements.map(literal);
      if (elements.every((element) => element !== null)) return [elements.join(" ")];
    }
    return node.getChildren(file).flatMap(lists);
  };
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(file) === "className" && node.initializer) {
      out.push(...lists(node.initializer));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** A string that is a full-bleed surface: it says both where and how high. */
function isSurface(classes: string): boolean {
  return /(^|\s)inset-0(\s|$)/.test(classes) && /(^|\s)z-40(\s|$)/.test(classes);
}

/**
 * Whether a file spells out a full-bleed surface, however it spells it.
 *
 * Both readings are kept: the whole-string one catches a surface written as a
 * constant anywhere in the file (not only in a `className`), and the class-list
 * one catches the split spellings it cannot see.
 */
function spellsASurface(source: string, fileName: string): boolean {
  return (
    stringsIn(source, fileName).some(isSurface) || classListsIn(source, fileName).some(isSurface)
  );
}

describe("PanelSurface", () => {
  it("is the only place a full-bleed surface is spelled out", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const rel = relative(UI, file);
      if (ALLOWED.has(rel)) continue;
      if (spellsASurface(readFileSync(file, "utf8"), file)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  // The guard is only worth its scan if it goes red for the spellings that are
  // not one literal — the two this missed before.
  it("reads a surface out of split class lists too", () => {
    expect(
      spellsASurface(
        'const x = <div className={["absolute","inset-0","z-40"].join(" ")} />;',
        "a.tsx",
      ),
    ).toBe(true);
    expect(
      spellsASurface("const x = <div className={`absolute inset-0 z-${40} bg-black`} />;", "a.tsx"),
    ).toBe(true);
    expect(
      spellsASurface('const x = <div className="absolute inset-0 z-40 bg-black" />;', "a.tsx"),
    ).toBe(true);
    // …and does not fire on a file that merely names one of the two, or that
    // names them in branches no element carries at the same time.
    expect(spellsASurface('const x = <div className="inset-0 bg-black" />;', "a.tsx")).toBe(false);
    expect(spellsASurface('const x = <div className="z-40" />;', "a.tsx")).toBe(false);
    expect(spellsASurface('const x = <div className={on ? "inset-0" : "z-40"} />;', "a.tsx")).toBe(
      false,
    );
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
      return !spellsASurface(source, rel);
    });
    expect(stale).toEqual([]);
  });
});
