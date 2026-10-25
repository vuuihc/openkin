import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * Zen hides the chrome, and this is the list of what the chrome is.
 *
 * `Cmd+.` puts one class on the shell root and each navigation surface carries a
 * marker class; `index.css` turns the pair into `display: none`. That choice is
 * only worth anything if the marker set stays the answer to "what does zen
 * hide", so this guard does three things a compiler cannot: it fixes the set, it
 * checks the rule those markers depend on is still there and still top-level, and
 * it checks that zen is still transient — the mode must not grow a stored
 * preference, which is the one thing about it that is easy to add and hard to
 * notice (P3 plan §2.3, §4).
 *
 * Source rather than DOM, like `PanelSurface.test.ts` and for the same reason:
 * the tree has no DOM test environment by design, and all three properties are
 * properties of the source text.
 */
// `ui/` — three levels up from this file, which sits at `ui/src/components/layout`.
const UI = fileURLToPath(new URL("../../..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", "dist"]);
const MARKER = "kin-zen-hide";
const ROOT_FLAG = "kin-zen";

/**
 * The surfaces zen hides, and what each one is.
 *
 * An allow-list rather than a pattern because the list *is* the decision: a new
 * chrome surface is fine, a new chrome surface that quietly stays on screen
 * during zen is not.
 */
const CHROME = new Map([
  ["src/components/layout/Sidebar.tsx", "the desktop navigation column"],
  ["src/components/layout/MobileTabBar.tsx", "the phone's bottom bar"],
  ["src/components/layout/AppShell.tsx", "the phone's top bar"],
  ["src/components/layout/SessionTabs.tsx", "the session tab strip"],
  ["src/components/layout/PanelSurface.tsx", "the session panel"],
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
        // `eslint.config.js`: a guard that asserts *about* a shape has to spell
        // the shape, and this one spells both class names.
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

const sources = sourceFiles().map((file) => {
  const rel = relative(UI, file);
  const source = readFileSync(file, "utf8");
  // Split once: a class list is one string, and both flags are classes in one.
  return { rel, source, classes: stringsIn(source, rel).flatMap((s) => s.split(/\s+/)) };
});

const withMarker = () =>
  sources
    .filter(({ classes }) => classes.includes(MARKER))
    .map(({ rel }) => rel)
    .sort();

describe("zen", () => {
  it("hides exactly the surfaces it names", () => {
    expect(withMarker()).toEqual([...CHROME.keys()].sort());
  });

  it("still names surfaces that are still chrome, so the list cannot rot", () => {
    // A stale entry is a hole: the surface could have been renamed away, and
    // this guard would keep waving it through.
    const stale = [...CHROME.keys()].filter((rel) => !withMarker().includes(rel));
    expect(stale).toEqual([]);
  });

  it("keeps the one rule the markers depend on, outside any layer", () => {
    const css = readFileSync(join(UI, "src/index.css"), "utf8");
    expect(css).toMatch(/\.kin-zen\s+\.kin-zen-hide\s*\{[^}]*display:\s*none/);
    // Top level, or it is inside `@layer components` and loses to the `md:flex`
    // it has to override — on order rather than on specificity, which is the
    // kind of breakage that reads as "zen stopped working on wide screens".
    const before = css.slice(0, css.search(/\.kin-zen\s+\.kin-zen-hide/));
    expect((before.match(/\{/g) ?? []).length).toBe((before.match(/\}/g) ?? []).length);
  });

  // The plan's guard row: zen is derived and transient. It is one class on the
  // root and one boolean in component state; the moment it gets a stored key it
  // has become a preference, which is what the parity plan says it must not be.
  it("is transient: one flag on the root, and no stored preference", () => {
    const flags = sources
      .filter(({ classes }) => classes.includes(ROOT_FLAG))
      .map(({ rel }) => rel);
    expect(flags).toEqual(["src/components/layout/AppShell.tsx"]);
    const stored = sources
      .filter(({ source }) => /localStorage[^\n]*zen|zen[^\n]*localStorage/i.test(source))
      .map(({ rel }) => rel);
    expect(stored).toEqual([]);
  });
});
