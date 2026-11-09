import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The top safe-area inset is spent exactly once at every width.
 *
 * On a phone the topmost bar owns it (`MobileHeader`, the sessions bar). From
 * `md` up there is no shared bar — the sidebar and the page each start at the
 * top of the window — so the shell root spends it for both columns. The pages
 * that render inside the shell must therefore keep their own `pt-safe` scoped
 * to phones, or an iPad in full screen would reserve the status bar twice.
 *
 * Source rather than DOM, like `zen.test.ts`: the tree has no DOM test
 * environment by design, and these are properties of the class strings the
 * components commit to.
 */
const UI = fileURLToPath(new URL("../../..", import.meta.url));

function source(path: string): string {
  return readFileSync(`${UI}/${path}`, "utf8");
}

/** Every string literal in a file, as the parser sees it. Comments do not count. */
function stringsIn(path: string): string[] {
  const out: string[] = [];
  const file = ts.createSourceFile(
    path,
    source(path),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push(node.text);
    } else if (ts.isTemplateExpression(node)) {
      // The shell root's classes are a template with `${zen ? ... : ""}` at the
      // end; the literal part still names `md:pt-safe`.
      out.push(node.head.text);
      for (const span of node.templateSpans) out.push(span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

/** The class tokens a file applies, one token per array entry. */
function classTokens(path: string): string[] {
  return stringsIn(path)
    .flatMap((value) => value.split(/\s+/))
    .filter(Boolean);
}

describe("top safe-area inset ownership", () => {
  it("keeps the desktop shell spending the inset once for both columns", () => {
    expect(classTokens("src/components/layout/AppShell.tsx")).toContain("md:pt-safe");
  });

  it("keeps the reconnect strip from spending it a second time below the shell's edge", () => {
    // The strip is in flow below the shell's padded top edge, so on desktop it
    // must not carry the inset. It still owns it on a phone, where the session
    // page's MobileHeader sits below the strip.
    expect(classTokens("src/components/layout/AppShell.tsx")).toContain("max-md:pt-safe");
    // Any unqualified `pt-safe` left in AppShell belongs to the phone-only
    // detail-route spacer, which is `md:hidden` and therefore never stacks
    // under the shell's `md:pt-safe`.
    const bare = stringsIn("src/components/layout/AppShell.tsx").filter((value) =>
      value.split(/\s+/).includes("pt-safe"),
    );
    expect(bare.length).toBeGreaterThan(0);
    for (const value of bare) {
      expect(value.split(/\s+/)).toContain("md:hidden");
    }
  });

  it("keeps page-level inset padding scoped to phones", () => {
    const tokens = classTokens("src/pages/TaskDetailPage.tsx");
    expect(tokens).not.toContain("pt-safe");
    expect(tokens.filter((token) => token === "max-md:pt-safe").length).toBeGreaterThanOrEqual(3);
  });

  it("keeps the phone's top bar owning the inset on phones", () => {
    const tokens = classTokens("src/components/mobile/MobileHeader.tsx");
    expect(tokens).toContain("md:hidden");
    expect(tokens).toContain("pt-safe");
  });

  it("keeps the utility that all of the above depend on", () => {
    expect(source("src/index.css")).toMatch(
      /\.pt-safe\s*\{\s*padding-top:\s*env\(safe-area-inset-top\);/,
    );
  });
});
