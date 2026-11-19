import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import postcss from "postcss";
import type { AtRule, Container, Document } from "postcss";
import { compile } from "tailwindcss";
import type { Config } from "tailwindcss";
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
 * The reconnect strip is the exception: while it is shown on a page-owned
 * route it is the topmost element on the phone, so the page below yields the
 * inset to it (`topInset` on the phone bar, a guard on the early returns).
 *
 * Two kinds of case, and both are needed. The token cases prove a component
 * still *asks* for the inset; the generated-CSS cases compile the real
 * `index.css` with the real config and prove Tailwind emits a rule for it. A
 * class string says nothing about the stylesheet: while `pt-safe` was a plain
 * class in `@layer utilities`, every `md:`/`max-md:` call site passed the
 * token cases and emitted no CSS at all (the 768–1023px iPad gap and the
 * phone early-return states spent no inset). The string is the intent; the
 * generated rule is the behaviour.
 */
const UI = fileURLToPath(new URL("../../..", import.meta.url));
const BASE = join(UI, "src");
const require = createRequire(join(UI, "package.json"));
const jiti = createJiti(join(UI, "tailwind.config.ts"));

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

/*
  The compiler harness, shared with `design/tailwind.test.ts` and copied here
  rather than imported: a test helper that another suite owns would couple the
  two files' failure modes. `compile(css, options)` reads no filesystem of its
  own, so the loaders below are the resolution the Vite/PostCSS pipeline
  performs — `@import "tailwindcss"` from the package, the stylesheet's own
  relative imports, and `@config` through jiti so the `.ts` config stays on the
  real path.
*/
async function loadStylesheet(id: string, base: string) {
  const file =
    id === "tailwindcss"
      ? require.resolve("tailwindcss/index.css")
      : id.startsWith(".")
        ? resolve(base, id)
        : require.resolve(id);
  return { path: file, base: dirname(file), content: readFileSync(file, "utf8") };
}

async function loadModule(id: string, base: string) {
  const file = id.startsWith(".") ? resolve(base, id) : require.resolve(id);
  const loaded = (await jiti.import(file)) as Config | { default: Config };
  const module = "default" in loaded ? loaded.default : loaded;
  return { path: file, base: dirname(file), module };
}

const OPTIONS = { base: BASE, loadStylesheet, loadModule };

/**
 * Every source file that applies a `pt-safe` token. `PanelSurface` is
 * deliberately absent: its phone skin is `panel-top-inset`, and the panel case
 * below rejects any `pt-safe` variant there.
 */
const SAFE_CONSUMERS = [
  "src/components/layout/AppShell.tsx",
  "src/pages/TaskDetailPage.tsx",
  "src/components/mobile/MobileHeader.tsx",
  "src/components/mobile/SessionsHeader.tsx",
];

/** The `pt-safe` tokens the console actually applies, variants included. */
function usedSafeTokens(): string[] {
  return [
    ...new Set(
      SAFE_CONSUMERS.flatMap(classTokens).filter((token) =>
        /^(?:[a-z0-9-]+:)*pt-safe$/.test(token),
      ),
    ),
  ];
}

/** The selector Tailwind writes for a candidate, e.g. `md:pt-safe`. */
function selectorFor(token: string): string {
  return `.${token.replace(/:/g, "\\:")}`;
}

let generated: Promise<string> | undefined;

/**
 * The real stylesheet, compiled with the real config, for every safe-area
 * token the tree uses. Compiled once; the candidates are constant for a run.
 */
function generatedCss(): Promise<string> {
  generated ??= (async () => {
    const candidates = [
      ...new Set(["pt-safe", "md:pt-safe", "max-md:pt-safe", ...usedSafeTokens()]),
    ];
    const compiler = await compile(readFileSync(join(BASE, "index.css"), "utf8"), OPTIONS);
    return compiler.build(candidates);
  })();
  return generated;
}

type Found = { selector: string; atRules: string[]; text: string };

/** The rules a stylesheet emits for exactly `selector`, and what wraps them. */
function rules(css: string, selector: string): Found[] {
  const found: Found[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (rule.selector !== selector) return;
    const atRules: string[] = [];
    let parent: Container | Document | undefined = rule.parent;
    while (parent) {
      const atRule = parent as AtRule;
      if (atRule.type === "atrule" && atRule.name !== "layer") {
        atRules.unshift(`@${atRule.name} ${atRule.params}`.trim());
      }
      parent = parent.parent;
    }
    found.push({ selector: rule.selector, atRules, text: rule.toString() });
  });
  return found;
}

describe("top safe-area inset ownership", () => {
  it("keeps the desktop shell spending the inset once for both columns", () => {
    expect(classTokens("src/components/layout/AppShell.tsx")).toContain("md:pt-safe");
  });

  it("keeps the reconnect strip from spending it a second time below the shell's edge", () => {
    // The strip is in flow below the shell's padded top edge, so on desktop it
    // must not carry the inset. It still owns it on a phone, where it is the
    // topmost element on a page-owned route and the page below yields it (the
    // disconnected case below).
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

  it("keeps the strip the only spender on a session page while the link is down", () => {
    // The strip owns the notch while it is shown; every page-owned top edge
    // below it must yield, or the page starts one inset below the strip.
    const page = "src/pages/TaskDetailPage.tsx";
    const file = ts.createSourceFile(
      page,
      source(page),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const yielded: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isConditionalExpression(node) &&
        node.whenFalse.getText(file).replace(/\s+/g, "") === '"max-md:pt-safe"'
      ) {
        yielded.push(node.condition.getText(file).replace(/\s+/g, " "));
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    // One per early return: cold start, load error, not found.
    expect(yielded).toHaveLength(3);
    for (const condition of yielded) {
      expect(condition).toBe('wsStatus === "disconnected"');
    }

    // The normal session bar yields the same way, through `TaskHeader`.
    expect(source("src/components/task/TaskHeader.tsx")).toMatch(/topInset=\{topInset\}/);

    // The files/PR overlay mounts inside the page row, below the strip, so it
    // yields through the same flag: one call for the session bar, one for the
    // panels. The flag defaults to spending, so every other `PanelSurface`
    // mount keeps the inset its phone bar owns.
    expect(source(page).match(/topInset=\{wsStatus !== "disconnected"\}/g)).toHaveLength(2);
    expect(source("src/components/task/TaskPanels.tsx")).toMatch(/topInset=\{topInset\}/);
    const surface = "src/components/layout/PanelSurface.tsx";
    expect(source(surface)).toMatch(/topInset = true/);
    expect(source(surface)).toMatch(/topInset \? "panel-top-inset" : ""/);

    // The flag becomes the class here, defaulting to the spend so every other
    // bar keeps the inset it owns.
    const mobile = "src/components/mobile/MobileHeader.tsx";
    expect(source(mobile)).toMatch(/topInset\?: boolean/);
    expect(source(mobile)).toMatch(/topInset \? "pt-safe" : ""/);
  });

  it("keeps the phone's top bar owning the inset on phones", () => {
    const tokens = classTokens("src/components/mobile/MobileHeader.tsx");
    expect(tokens).toContain("md:hidden");
    expect(tokens).toContain("pt-safe");
  });
});

describe("top safe-area inset generation", () => {
  it("emits the bare pt-safe rule the phone bars rely on", async () => {
    const found = rules(await generatedCss(), ".pt-safe");
    expect(found).toHaveLength(1);
    expect(found[0].text).toContain("padding-top: env(safe-area-inset-top)");
  });

  it("emits a generated rule for md:pt-safe", async () => {
    const found = rules(await generatedCss(), selectorFor("md:pt-safe"));
    expect(found).toHaveLength(1);
    expect(found[0].atRules).toContain("@media (width >= 48rem)");
    expect(found[0].text).toContain("padding-top: env(safe-area-inset-top)");
  });

  it("emits a generated rule for max-md:pt-safe", async () => {
    const found = rules(await generatedCss(), selectorFor("max-md:pt-safe"));
    expect(found).toHaveLength(1);
    expect(found[0].atRules).toContain("@media (width < 48rem)");
    expect(found[0].text).toContain("padding-top: env(safe-area-inset-top)");
  });

  it("every pt-safe variant these consumers use is emitted", async () => {
    const tokens = usedSafeTokens();
    // The three shapes the shell relies on. A fourth is fine; a missing one is
    // not, so the list is read from the tree and each token must compile.
    expect(tokens).toEqual(expect.arrayContaining(["pt-safe", "md:pt-safe", "max-md:pt-safe"]));
    const css = await generatedCss();
    for (const token of tokens) {
      const found = rules(css, selectorFor(token));
      expect(found.length, `${token} produced no CSS rule`).toBeGreaterThan(0);
      expect(found[0].text).toContain("padding-top: env(safe-area-inset-top)");
    }
  });

  it("keeps the panel overlay spending the phone's top inset", () => {
    // The overlay covers `MobileHeader`, which is the bar that owns the top
    // inset on a phone, so below `md` the surface itself has to spend it.
    // Above `md` the shell root's `md:pt-safe` spends it once for both
    // columns, so this guard stays phone-scoped. No `pt-safe` variant may
    // appear here either: the skin is the one spender on the overlay, and a
    // variant would make it two.
    const tokens = classTokens("src/components/layout/PanelSurface.tsx");
    expect(tokens).toContain("panel-top-inset");
    expect(tokens.filter((t) => /(^|:)pt-safe$/.test(t))).toEqual([]);
    // And the class must be emitted CSS, not a Tailwind variant name: the
    // panel skin owns a real media query in `@layer utilities`, beside
    // `pt-safe` rather than derived from it, so the phone guard does not
    // depend on how the token is generated.
    expect(source("src/index.css")).toMatch(
      /@media \(max-width: 767\.98px\) \{\s*\.panel-top-inset\s*\{\s*padding-top: env\(safe-area-inset-top\);/,
    );
  });
});
