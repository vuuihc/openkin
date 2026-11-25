import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import postcss from "postcss";
import type { AtRule, Container, Document, Node as PostcssNode } from "postcss";
import { compile } from "tailwindcss";
import type { Config } from "tailwindcss";
import { describe, expect, it } from "vitest";
import { LEADING, TYPE_ROLES } from "./type";

/**
 * The ladder, through the build pipeline rather than through a parser.
 *
 * `tailwind.config.ts` imports the sizes from `design/type.ts`, which Tailwind
 * reaches through jiti — a path nothing else in the repo exercises, and one
 * that fails *silently*: if the import stops resolving, every `text-<role>`
 * class quietly disappears and the console inherits whatever size it had. These
 * cases compile real utilities with the real config, so that failure is a red
 * test instead of a screenshot someone has to notice.
 *
 * Tailwind 4 has no `resolveConfig` and no PostCSS entry that takes a `content`
 * array. Its compiler is `compile(css, options)`, which reads no filesystem of
 * its own: the two loaders below are the resolution the Vite/PostCSS pipeline
 * performs — `@import "tailwindcss"` from the package, the stylesheet's own
 * relative imports, and `@config` through jiti so the `.ts` config and its
 * `design/type.ts` import stay on the real path. `build(candidates)` is then
 * the list of class names a page rendered, which is exactly what these cases
 * need to keep the old `content: [{ raw }]` behaviour.
 */

const UI = fileURLToPath(new URL("../..", import.meta.url));
const BASE = join(UI, "src");
const require = createRequire(join(UI, "package.json"));
const jiti = createJiti(join(UI, "tailwind.config.ts"));
const PROBE = '@import "tailwindcss";\n@config "../tailwind.config.ts";';

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

async function utilities(classes: string): Promise<string> {
  const compiler = await compile(PROBE, OPTIONS);
  return compiler.build(classes.split(/\s+/).filter(Boolean));
}

/** The real stylesheet, compiled with the real config, for `classes` only. */
async function stylesheet(classes: string[] = []): Promise<string> {
  const compiler = await compile(readFileSync(join(UI, "src/index.css"), "utf8"), OPTIONS);
  return compiler.build(classes);
}

/** Every cascade layer an element passes through, outermost first. */
function layersOf(node: PostcssNode): string[] {
  const layers: string[] = [];
  let parent: Container | Document | undefined = node.parent;
  while (parent) {
    const atRule = parent as AtRule;
    if (atRule.type === "atrule" && atRule.name === "layer" && atRule.params) {
      layers.unshift(atRule.params);
    }
    parent = parent.parent;
  }
  return layers;
}

type Found = {
  selector: string;
  layers: string[];
  atRules: string[];
  text: string;
};

/**
 * The rules a stylesheet emits for a selector, with the layers and at-rules
 * they sit inside. The old cases compared raw strings; Tailwind 4 nests
 * variants (`&:focus`, `&::placeholder`) and wraps hover in `@media (hover)`,
 * so walking the AST is what keeps "which layer does this rule sort in"
 * answerable instead of a substring guess.
 */
function rules(css: string, selector: string, exact = true): Found[] {
  const found: Found[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (exact ? rule.selector !== selector : !rule.selector.includes(selector)) return;
    const atRules: string[] = [];
    let parent: Container | Document | undefined = rule.parent;
    while (parent) {
      const atRule = parent as AtRule;
      if (atRule.type === "atrule" && atRule.name !== "layer") {
        atRules.unshift(`@${atRule.name} ${atRule.params}`.trim());
      }
      parent = parent.parent;
    }
    found.push({ selector: rule.selector, layers: layersOf(rule), atRules, text: rule.toString() });
  });
  return found;
}

function one(css: string, selector: string, exact = true): Found {
  const found = rules(css, selector, exact);
  expect({ selector, count: found.length }).toEqual({ selector, count: 1 });
  return found[0];
}

/** The class selectors a stylesheet emits into `@layer utilities`. */
function utilitySelectors(css: string): string[] {
  const selectors: string[] = [];
  postcss.parse(css).walkRules((rule) => {
    if (layersOf(rule).includes("utilities")) selectors.push(rule.selector);
  });
  return selectors;
}

describe("type ladder through Tailwind", () => {
  it("emits every role at the size the ladder declares", async () => {
    const css = await utilities(TYPE_ROLES.map((r) => `text-${r.role}`).join(" "));
    for (const role of TYPE_ROLES) {
      expect({ role: role.role, emitted: css.includes(`.text-${role.role} {`) }).toEqual({
        role: role.role,
        emitted: true,
      });
      expect(css).toContain(`font-size: ${role.px}px`);
    }
  });

  it("no longer emits any of the default sizes", async () => {
    // Spelled by joining the prefix on, like the ladder's `absorbed` lists: a
    // literal default name in this tree is what the leftover-size guard in
    // `tokens.test.ts` forbids, and it reads this file too.
    const removed = ["xs", "sm", "base", "lg", "xl", "2xl", "3xl"];
    const css = await utilities(removed.map((name) => `text-${name}`).join(" "));
    // Assignment, not `extend`: the defaults are gone, so these produce no
    // utility. Tailwind 4 always emits Preflight into `@layer base`, so the
    // claim is about the utilities layer rather than about the whole sheet.
    expect(utilitySelectors(css).filter((s) => /^\.text-/.test(s))).toEqual([]);
  });

  it("emits a line box with every role", async () => {
    // A role that only sets a size leaves the line box to Preflight, which is
    // how the whole console ended up on 1.5 while the ladder declared three
    // leading steps that reached almost nothing. Tailwind 4 words the same
    // declaration as a variable fallback: `line-height: var(--tw-leading,
    // <the role's step>)`, so the step is still what the browser uses when the
    // element says nothing.
    const css = await utilities(TYPE_ROLES.map((r) => `text-${r.role}`).join(" "));
    for (const role of TYPE_ROLES) {
      const rule = css.slice(css.indexOf(`.text-${role.role} {`));
      expect({
        role: role.role,
        leading: rule
          .slice(0, rule.indexOf("}"))
          .includes(`line-height: var(--tw-leading, ${LEADING.ui})`),
      }).toEqual({ role: role.role, leading: true });
    }
  });

  it("lets an explicit leading win over the role's", async () => {
    // The prose sites are the exception that must keep working: the role's
    // line-height and `leading-prose` are both one class deep, so only CSS
    // order decides which wins. If Tailwind ever emits them the other way
    // round, every paragraph in the console silently tightens.
    const css = await utilities("text-body leading-prose leading-flush");
    const body = css.indexOf(".text-body {");
    expect(body).toBeGreaterThan(-1);
    // Between themselves the leading steps are ordered by name, which never
    // matters: an element carries one. What matters is that all of them come
    // after the roles.
    expect(css.indexOf(".leading-prose {")).toBeGreaterThan(body);
    expect(css.indexOf(".leading-flush {")).toBeGreaterThan(body);
  });
});

/**
 * The rest of the ladders, through the same pipeline and for the same reason:
 * nothing else in the repo compiles a class name, so a step that stops
 * resolving is invisible until someone looks at the screen and wonders why the
 * section labels are loose. Each row is a class the tree uses and a fragment of
 * the declaration the browser has to end up with.
 */
describe("scale ladders through Tailwind", () => {
  const STEPS: [string, string][] = [
    ["tracking-label", "letter-spacing: 0.06em"],
    ["leading-prose", "line-height: 1.625"],
    ["leading-flush", "line-height: 1"],
    ["leading-4", "line-height: 1rem"],
    // The colour is not pinned here any more: since S5 it is a token, so the
    // declaration ends at the `var()` and how dark the value is belongs to
    // `tokens.test.ts`, which measures it in both schemes. What this still
    // proves is the half that only a build can: the step resolves, and the
    // geometry the ladder declares is the geometry that ships. Tailwind 4
    // inserts a `--tw-shadow-color` hook in front of the token, so the token
    // is still the colour the drop falls back to.
    ["shadow-e1", "0 1px 2px var(--tw-shadow-color, var(--kin-shadow-1))"],
    ["shadow-e3", "0 40px 90px -20px var(--tw-shadow-color, var(--kin-shadow-3))"],
    // Tailwind 4 spells the spacing ruler as `calc(var(--spacing) * 11)`
    // instead of the resolved `2.75rem`; the second half of the assertion
    // below reads `--spacing` out of the same build, so 0.25rem × 11 is still
    // measured as the 44px floor rather than trusted.
    ["min-h-11", "min-height: calc(var(--spacing) * 11)"],
    ["w-rail", "width: 208px"],
    ["w-rail-compact", "width: 64px"],
    ["w-list", "width: 304px"],
    ["w-inspector-rail", "width: 300px"],
    ["max-w-conversation", "max-width: 720px"],
    ["max-w-sheet", "max-width: min(100%, 420px)"],
    ["max-w-inspector", "max-width: min(40%, 18rem)"],
    // Not a scale step, but the two lines whose failure is an accessibility
    // failure: a token name that stopped resolving would emit no ring — or no
    // outline — at all, and nothing on screen would say so.
    ["ring-kin-focus-ring", "--tw-ring-color: var(--kin-focus-ring)"],
    ["outline-kin-focus-ring", "outline-color: var(--kin-focus-ring)"],
  ];

  it("emits every step at the value the ladder declares", async () => {
    const css = await utilities(STEPS.map(([name]) => name).join(" "));
    for (const [name, declaration] of STEPS) {
      expect({ name, emitted: css.includes(declaration) }).toEqual({ name, emitted: true });
    }
    expect(css).toContain("--spacing: 0.25rem");
  });

  /**
   * The comment above `.touch-lg` is the paragraph a future agent reads before
   * deciding whether the 44px floor can be widened past `md`. Its width is
   * therefore a claim about the shipped column, and it has already outlived one
   * layout (it still said 248px when `w-list` was 304px). Read the configured
   * step rather than restating the number here, so the prose and the shell
   * cannot drift apart again. A historical figure is allowed only where the
   * same sentence dates it as the old layout's measurement.
   */
  it("the touch-floor comment quotes the list column it is describing", async () => {
    const loaded = (await jiti.import(join(UI, "tailwind.config.ts"))) as
      Config | { default: Config };
    const config = "default" in loaded ? loaded.default : loaded;
    const widths =
      (config.theme as { extend?: { width?: Record<string, string> } } | undefined)?.extend
        ?.width ?? {};
    const configured = widths.list;
    expect(configured, "the width ladder has no `list` step").toBeDefined();
    const listPx = Number(String(configured).replace(/px$/, ""));
    expect(Number.isFinite(listPx), `the list step is not a px width: ${configured}`).toBe(true);

    const css = readFileSync(join(BASE, "index.css"), "utf8");
    const open = css.indexOf("/* The 44px floor for the app's controls");
    expect(open, "the touch-floor comment block is not in index.css").toBeGreaterThan(-1);
    const close = css.indexOf("*/", open);
    const block = css.slice(open, close + 2);

    const claims = [...block.matchAll(/(\d{2,4})px\s+(?:sidebar|list column|column)/gi)];
    expect(claims.length, "the comment no longer names the column it describes").toBeGreaterThan(0);

    for (const claim of claims) {
      const px = Number(claim[1]);
      if (px === listPx) continue;
      const before = block.slice(Math.max(0, (claim.index ?? 0) - 160), claim.index);
      const after = block.slice(claim.index, (claim.index ?? 0) + 90);
      const historical = /old|previous|旧/.test(before) && /20\d\d-\d\d-\d\d/.test(before + after);
      expect(
        historical,
        `expected the touch-floor comment to quote the ${listPx}px list column, found ${px}px`,
      ).toBe(true);
    }
    expect(
      block,
      `the touch-floor comment does not quote the configured ${listPx}px list column`,
    ).toContain(`${listPx}px`);
  });

  it("no longer emits the names the ladders replaced", async () => {
    const removed = [
      ["wide", "wider", "widest"].map((n) => "tracking-" + n),
      ["tight", "normal", "relaxed", "snug", "loose"].map((n) => "leading-" + n),
      ["sm", "md", "lg", "xl", "2xl", "inner", "none"].map((n) => "shadow-" + n),
      // The bare DEFAULT step, split so this line does not name it.
      ["shad" + "ow"],
      ["card", "pill"].map((n) => "rounded-" + n),
    ].flat();
    const css = await utilities(removed.join(" "));
    const emitted = new Set(utilitySelectors(css));
    // The `none` step is the one exception, and it is not a ladder step: v4
    // ships it as a static reset (`box-shadow: 0 0 #0000`) that assigning
    // `boxShadow` cannot remove. The design rule still refuses it by name in
    // `tokens.test.ts`'s off-ladder case, so the compiled claim is about the
    // elevation steps themselves. The name is split so this file does not
    // spell the forbidden class in a scanned string.
    expect(
      removed.filter((name) => name !== "shad" + "ow-none" && emitted.has(`.${name}`)),
    ).toEqual([]);
  });
});

/**
 * The cascade foundation Tailwind 4 changes, measured on the real stylesheet.
 *
 * Every case below compiles `index.css` itself — imports, config, custom
 * layers — because these are properties of the whole sheet, not of a utility.
 * The spike measured three regressions that only appear after the upgrade: the
 * page background flipping to `--kin-page` (unlayered beats layered), the
 * default radius step doubling, and v4's new placeholder/outline defaults.
 * Each one is pinned here so a future Tailwind bump has to fail a test rather
 * than a screenshot.
 */
describe("cascade foundation through the real stylesheet", () => {
  it("declares the cascade order before Astryx arrives", async () => {
    const css = await stylesheet(["bg-kin-bg"]);
    const declared = [...css.matchAll(/@layer\s+([^;{}]+);/g)]
      .map((match) => match[1].split(",").map((name) => name.trim()))
      .find((names) => names.includes("reset"));
    expect(declared).toEqual([
      "reset",
      "theme",
      "base",
      "astryx-base",
      "astryx-theme",
      "components",
      "utilities",
    ]);
    // The declaration is only half of it: the emitted rules have to land in
    // those layers. Then Astryx's reset can sort before Tailwind's base, its
    // component layers before ours, and the utilities stay last.
    expect(one(css, "body").layers).toEqual(["base"]);
    expect(one(css, ".bg-kin-bg").layers).toEqual(["utilities"]);
  });

  it("keeps body background overridable by the page token utility", async () => {
    // The specific v3→v4 regression from the spike: unlayered wins over every
    // layer regardless of specificity, so leaving `body` unlayered turned the
    // shell from `--kin-bg` (#1a1a1c) to `--kin-page` (#0e0e10). The body
    // fallback has to stay for pages that paint nothing, and the class on
    // <body> has to win where it is present.
    const css = await stylesheet(["bg-kin-bg", "bg-kin-panel"]);
    const body = one(css, "body");
    expect(body.layers).toEqual(["base"]);
    expect(body.text).toContain("background: var(--kin-page)");
    const win = one(css, ".bg-kin-bg");
    expect(win.layers).toEqual(["utilities"]);
    expect(win.text).toContain("background-color: var(--kin-bg)");
    // The control: a second real background utility, so the claim is about
    // the layer and not about one class name. (`bg-kin-page` is not a member
    // of the palette: `--kin-page` is the base rule's own fallback.)
    expect(one(css, ".bg-kin-panel").layers).toEqual(["utilities"]);
    const order = [...css.matchAll(/@layer\s+([^;{}]+);/g)]
      .map((match) => match[1].split(",").map((name) => name.trim()))
      .find((names) => names.includes("reset")) as string[];
    expect(order.indexOf("base")).toBeLessThan(order.indexOf("utilities"));
  });

  it("emits the chosen rounded-sm radius through Tailwind 4", async () => {
    // Measured: Tailwind 4's default `sm` is 4px; the four call sites (an
    // inline highlight, the cwd picker's focusable path, two heatmap cells)
    // were drawn at 2px under v3. The config pins `sm` instead of accepting a
    // silent redesign; the next step stays the 6px `md`.
    const css = await utilities("rounded-sm rounded-md");
    expect(one(css, ".rounded-sm").text).toContain("border-radius: 0.125rem");
    expect(css).toContain("--radius-md: 0.375rem");
  });

  it("keeps placeholder ink on the Kin muted token", async () => {
    // Tailwind 4's Preflight paints `::placeholder` with currentColor at 50%,
    // where v3 used a grey. The input composition must still override it with
    // the measured muted token, and it has to be the emitted rule — not the
    // `@apply` string in the source — that says so.
    const css = await stylesheet();
    const input = one(css, ".kin-input");
    expect(input.layers).toEqual(["components"]);
    expect(input.text).toMatch(/(?:&)?::placeholder\s*\{[^}]*color:\s*rgb\(var\(--kin-muted-rgb\)/);
    // The default it is overriding is still there, in the earlier layer.
    const base = css.slice(css.indexOf("@layer base"), css.indexOf("@layer utilities"));
    expect(base).toMatch(/::placeholder\s*\{[^}]*color:\s*currentcolor/);
    // v3 painted every placeholder `colors.gray.400` (#9ca3af); the config
    // assigns its own palette, so v3 itself fell back to that hex. The
    // compatibility rule restores it for fields with neither `.kin-input` nor a
    // `placeholder:` utility, and sits after preflight inside `base`, so the
    // muted token above still wins from the later layer.
    const legacy = one(css, "input::placeholder, textarea::placeholder");
    expect(legacy.layers).toEqual(["base"]);
    expect(legacy.text).toContain("color: #9ca3af");
  });

  it("restores v3 preflight's pointer cursor on buttons", async () => {
    // v3 preflight gave `button` and `[role="button"]` a pointer cursor; v4
    // removed the rule, which changes the desktop cursor over every
    // `.kin-btn-*`. `cursor-*` utilities still sort later, so an explicit
    // choice wins.
    const css = await stylesheet();
    const pointer = one(css, 'button, [role="button"]');
    expect(pointer.layers).toEqual(["base"]);
    expect(pointer.text).toContain("cursor: pointer");
    expect(one(css, ":disabled").text).toContain("cursor: default");
  });

  it("keeps outline-none and forced-colors focus behavior explicit", async () => {
    // Tailwind 4 split v3's single `outline-none` in two: the bare utility now
    // only sets `outline-style: none`, and the forced-colors transparent
    // outline moved to `outline-hidden`. Every existing call site was written
    // against the v3 meaning, so `index.css` redefines the utility. This case
    // compiles the real stylesheet and checks the emitted rules, not the
    // source: delete the `@utility` block and the forced-colors assertions
    // fail on `.outline-none` and on `.kin-input`'s `@apply` alike.
    const css = await stylesheet(["outline-none"]);
    const none = one(css, ".outline-none");
    expect(none.layers).toEqual(["utilities"]);
    expect(none.text).toContain("--tw-outline-style: none");
    expect(none.text).toContain("outline-style: none");
    expect(none.text).toContain("forced-colors");
    expect(none.text).toContain("outline: 2px solid transparent");
    // `outline-hidden` keeps saying the same thing, so a future migration to
    // the new name is a rename and not a behaviour change.
    const hidden = one(await utilities("outline-hidden"), ".outline-hidden");
    expect(hidden.text).toContain("forced-colors");
    expect(hidden.text).toContain("outline: 2px solid transparent");
    // The accessible answer for the filled/boxed controls is not `outline`;
    // it is the focus ring on the token, which the stylesheet must still emit.
    const input = one(css, ".kin-input");
    expect(input.text).toContain("--tw-ring-color: var(--kin-focus-ring)");
    expect(input.text).toContain("--tw-ring-shadow");
    // `.kin-input` spends `outline-none` through `@apply`, so the composed
    // rule is the evidence that the control keeps its High Contrast indicator.
    expect(input.text).toContain("forced-colors");
  });

  it("compiles custom button compositions without applying a custom class", async () => {
    // Tailwind 4 rejects `@apply kin-btn` (a custom class), so the shared
    // geometry is a selector group. Every variant is used on its own, so each
    // one has to keep the whole button, not just its colours.
    const css = await stylesheet();
    // Comments go first: this file names the forbidden composition in prose,
    // and a scan that failed on its own explanation would be a guard nobody
    // keeps.
    const source = readFileSync(join(UI, "src/index.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source).not.toMatch(/@apply[^;]*\bkin-btn\b/);
    const shared = one(
      css,
      ".kin-btn, .kin-btn-primary, .kin-btn-secondary, .kin-btn-approve, .kin-btn-deny",
    );
    expect(shared.layers).toEqual(["components"]);
    for (const declaration of [
      "display: inline-flex",
      "min-height: calc(var(--spacing) * 11)",
      "border-radius: var(--radius-xl)",
      "padding-inline: calc(var(--spacing) * 3)",
      "font-size: 14px",
      "font-weight: var(--font-weight-semibold)",
      "transition-property",
    ]) {
      expect({ declaration, emitted: shared.text.includes(declaration) }).toEqual({
        declaration,
        emitted: true,
      });
    }
    const variants: [string, string[]][] = [
      [
        ".kin-btn-primary",
        [
          "background-color: rgb(var(--kin-blue-rgb) / 1)",
          "color: var(--kin-on-brand)",
          "brightness(110%)",
        ],
      ],
      [
        ".kin-btn-secondary",
        [
          "border-color: var(--kin-hairline-strong)",
          "background-color: var(--kin-fill)",
          "background-color: var(--kin-fill-strong)",
        ],
      ],
      [
        ".kin-btn-approve",
        [
          "background-color: rgb(var(--kin-orange-rgb) / 1)",
          "color: var(--kin-on-status)",
          "brightness(110%)",
        ],
      ],
      [
        ".kin-btn-deny",
        ["border-color: var(--kin-hairline-strong)", "background-color: var(--kin-fill)"],
      ],
    ];
    for (const [selector, declarations] of variants) {
      const rule = one(css, selector);
      expect(rule.layers).toEqual(["components"]);
      for (const declaration of declarations) {
        expect({ selector, declaration, emitted: rule.text.includes(declaration) }).toEqual({
          selector,
          declaration,
          emitted: true,
        });
      }
    }
    expect(
      one(
        css,
        ".kin-btn:focus-visible, .kin-btn-primary:focus-visible, .kin-btn-secondary:focus-visible, .kin-btn-approve:focus-visible, .kin-btn-deny:focus-visible",
      ).text,
    ).toContain("outline: 2px solid var(--kin-focus-ring)");
  });

  it("floors a coarse tablet chip at 44px without changing the Mac's density", async () => {
    // The `/new` draft's cover chip measured 75×27.9 at 820×1180 with a coarse
    // pointer: the chip is an anchor, so the global floor's selector list
    // (buttons, selects, `[role="button"]`, inputs) never matches it, and the
    // chip's own `sm:min-h-0` drops `min-h-11` at ≥640. The global coarse arm
    // now reaches 1023.98px, and the chip's own class matches that same arm, so
    // a coarse pointer in the iPad band takes 44px while a fine pointer keeps
    // the Mac's density. The doubled class beats `sm:` utilities regardless of
    // emission order, the same reason `.kin-composer-input.kin-composer-input`
    // is doubled.
    const css = await stylesheet([]);
    const chip = one(css, ".touch-floor.touch-floor");
    expect(chip.layers).toEqual(["utilities"]);
    expect(chip.atRules.join(" ")).toContain("pointer: coarse");
    expect(chip.atRules.join(" ")).toContain("max-width: 1023.98px");
    expect(chip.text).toContain("min-height: 44px");
    expect(chip.text).toContain("min-width: 44px");
  });

  it("reaches the iPad band with the 44px coarse floor (KIN-CONTINUE-007 item 5)", async () => {
    // The signed story KIN-CONTINUE-007 item 5 / D4 (rsi/DECISIONS.md, 2026-11-24
    // 03:50 +08) moves the coarse-pointer arm of the floor to 1023.98px, so an
    // iPad in portrait takes its 44px controls from the pointer, never from a
    // width breakpoint (AGENTS 16). The phone width arm stays at 639.98px: a
    // narrow Mac window with a mouse keeps desktop density. The 768–1023 band
    // costs neither name at the 304px list column (126.5px project name, 97.7px
    // row title, measured 2026-11-23 by rsi/runtime/ux/measure-list-shell.mjs),
    // which is what the comment above the rule records.
    const css = await stylesheet([]);
    const floor = one(css, ".touch-lg button:not([data-touch-mini])", false);
    // PostCSS re-emits the query's spacing, so the two arms are asserted
    // separately rather than as one exact media string.
    const atRules = floor.atRules.join(" ");
    expect(atRules).toContain("pointer: coarse");
    expect(atRules).toContain("max-width: 1023.98px");
    expect(atRules).toContain("max-width: 639.98px");
    expect(atRules).not.toContain("767.98px");
    expect(floor.layers).toEqual(["utilities"]);
    expect(floor.text).toContain("min-height: 44px");
    expect(floor.text).toContain("min-width: 44px");
  });

  it("preserves existing utility overrides for safe areas and touch controls", async () => {
    // Custom utilities stay in `@layer utilities` and are emitted *after* the
    // generated ones, which is the source order the safe-area helpers and
    // `.touch-mini` already relied on. `.safe-pad` deliberately stays
    // unlayered; moving it into `base` would invert it against `px-*`.
    const css = await stylesheet(["px-4", "w-4"]);
    expect(rules(css, ".px-4").length).toBe(1);
    expect(css.indexOf(".px-4")).toBeLessThan(css.indexOf(".px-safe"));
    const gutter = one(css, ".px-safe");
    expect(gutter.layers).toEqual(["utilities"]);
    expect(gutter.text).toContain("max(1rem, env(safe-area-inset-left))");
    const fullBleed = one(css, ".safe-pad");
    expect(fullBleed.layers).toEqual([]);
    expect(fullBleed.text).toContain("env(safe-area-inset-bottom)");
    const mini = one(css, ".touch-mini");
    expect(mini.layers).toEqual(["utilities"]);
    expect(mini.atRules.join(" ")).toContain("pointer: coarse");
    expect(mini.text).toContain("width: 22px");
    expect(mini.text).toContain("opacity: 0.85");
    const floor = one(css, ".touch-lg button:not([data-touch-mini])", false);
    expect(floor.layers).toEqual(["utilities"]);
    expect(floor.text).toContain("min-height: 44px");
    const composer = one(css, ".kin-composer-input.kin-composer-input", false);
    expect(composer.layers).toEqual(["utilities"]);
    expect(composer.text).toContain("min-height: 44px");
  });
});
