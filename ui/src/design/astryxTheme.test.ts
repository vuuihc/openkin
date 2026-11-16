// @vitest-environment jsdom
/**
 * The bridge's contract.
 *
 * The point of this file is the first case: every Kin token has a decision.
 * The rest guard the shape of those decisions — that a mapping points at a real
 * Astryx token, that no Astryx token is given two Kin values, and that the two
 * floors the provider promises (44px on touch, motion unchanged) are actually
 * in the theme rather than in a comment.
 *
 * Two more contracts keep the mounted bridge honest: Astryx's runtime prose
 * defaults must be neutralised in `index.css` (a bare `<p>` may not stop
 * inheriting its parent's ink), and the Provider must hand Astryx the live
 * scheme and locale rather than a value captured at mount.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement, type ReactNode } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { generateThemeCSS, useLocale as useAstryxLocale, useTranslator } from "@astryxdesign/core";
import {
  colorDefaults,
  durationDefaults,
  easeDefaults,
  focusDefaults,
  shadowDefaults,
  sizeDefaults,
  spacingDefaults,
  borderDefaults,
  fontWeightDefaults,
  textSizeDefaults,
  typographyDefaults,
  typeScaleDefaults,
  radiusDefaults,
} from "@astryxdesign/core/theme/tokens.stylex";
import { getLocale, setLocale } from "../i18n";
import { AstryxProvider } from "./AstryxProvider";
import {
  astryxLocaleFor,
  astryxTokenValues,
  COARSE_POINTER_CONTROL_FLOOR,
  kinAstryxTheme,
  KIN_TOKEN_BINDINGS,
  kinExtensionTokens,
} from "./astryxTheme";
import { PRESENTED_TOKENS, cssValue } from "./colors";

/** Read a file from the `ui/` package (the Vitest root), independent of the DOM URL. */
function uiFile(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

/** Every Astryx core token name, read from the defaults the package exports. */
const ASTRYX_TOKEN_NAMES = new Set([
  ...Object.keys(colorDefaults),
  ...Object.keys(spacingDefaults),
  ...Object.keys(sizeDefaults),
  ...Object.keys(borderDefaults),
  ...Object.keys(focusDefaults),
  ...Object.keys(radiusDefaults),
  ...Object.keys(shadowDefaults),
  ...Object.keys(durationDefaults),
  ...Object.keys(easeDefaults),
  ...Object.keys(typographyDefaults),
  ...Object.keys(textSizeDefaults),
  ...Object.keys(fontWeightDefaults),
  ...Object.keys(typeScaleDefaults),
]);

describe("Kin token map", () => {
  it("gives every Kin token a mapping or a recorded Kin extension", () => {
    const undecided = PRESENTED_TOKENS.filter((name) => KIN_TOKEN_BINDINGS[name] === undefined);
    expect(undecided, "Kin token(s) with no Astryx mapping and no extension reason").toEqual([]);
  });

  it("does not carry entries for tokens outside the Kin inventory", () => {
    const inventory = new Set(PRESENTED_TOKENS);
    const stale = Object.keys(KIN_TOKEN_BINDINGS).filter((name) => !inventory.has(name));
    expect(stale, "mapping entries for token(s) design/colors.ts does not present").toEqual([]);
  });

  it("explains every Kin extension", () => {
    const unexplained = Object.entries(KIN_TOKEN_BINDINGS)
      .filter(([, binding]) => "extension" in binding)
      .filter(([, binding]) => "extension" in binding && binding.extension.trim().length < 20)
      .map(([name]) => name);
    expect(unexplained).toEqual([]);
  });

  it("maps onto real Astryx core tokens, each exactly once", () => {
    const seen = new Map<string, string>();
    const unknown: string[] = [];
    const duplicated: string[] = [];
    for (const [kinToken, binding] of Object.entries(KIN_TOKEN_BINDINGS)) {
      if (!("astryx" in binding)) continue;
      expect(binding.astryx.length, `${kinToken} maps to no Astryx token`).toBeGreaterThan(0);
      for (const astryxToken of binding.astryx) {
        if (!ASTRYX_TOKEN_NAMES.has(astryxToken)) unknown.push(`${kinToken} -> ${astryxToken}`);
        const previous = seen.get(astryxToken);
        if (previous) duplicated.push(`${astryxToken} (${previous} and ${kinToken})`);
        seen.set(astryxToken, kinToken);
      }
    }
    expect(unknown, "not an Astryx core token").toEqual([]);
    expect(duplicated, "Astryx token written by two Kin tokens").toEqual([]);
  });

  it("writes the Kin custom property, not a copied value", () => {
    const values = astryxTokenValues();
    for (const [kinToken, binding] of Object.entries(KIN_TOKEN_BINDINGS)) {
      if (!("astryx" in binding)) continue;
      for (const astryxToken of binding.astryx) {
        expect(values[astryxToken], `${astryxToken} value`).toBe(cssValue(kinToken));
      }
    }
    expect(Object.keys(values).length).toBeGreaterThan(0);
  });

  it("keeps exactly the tokens Astryx has no meaning for as extensions", () => {
    expect(kinExtensionTokens().sort()).toEqual(
      [
        "--kin-agent-claude",
        "--kin-agent-codex",
        "--kin-agent-doubao",
        "--kin-agent-droid",
        "--kin-agent-trae",
        "--kin-agent-workbuddy",
        "--kin-agent-zcode",
        "--kin-bubble-user",
        "--kin-fill-strong",
        "--kin-inspector",
        "--kin-muted-rgb",
        "--kin-shadow-1",
        "--kin-shadow-2",
        "--kin-shadow-3",
        "--kin-sidebar",
      ].sort(),
    );
  });
});

describe("kinAstryxTheme", () => {
  it("is the Kin theme, extending the neutral base", () => {
    expect(kinAstryxTheme.name).toBe("kin");
    // Extending neutral means the unmapped Astryx tokens keep their shipped
    // values instead of resolving to nothing.
    expect(kinAstryxTheme.tokens["--color-text-primary"]).toBe(cssValue("--kin-text"));
  });

  it("keeps Kin's console font stack instead of the neutral base's Figtree", () => {
    // Astryx's component layer writes `:scope { font-family:
    // var(--font-family-body) }` on the theme wrapper, which outranks the base
    // layer and would otherwise repaint the whole console in Figtree.
    expect(kinAstryxTheme.tokens["--font-family-body"]).toBe("var(--console-font-sans)");
    expect(kinAstryxTheme.tokens["--font-family-heading"]).toBe("var(--console-font-sans)");

    // The neutral base's coarse-pointer rule re-emits its typography axis,
    // families included, in a later media block for screens below `lg`; the
    // 44px rule is appended after it and must carry the same stack or phones
    // fall back to Figtree.
    const rules = kinAstryxTheme.__adaptationRules ?? [];
    const coarse = [...rules]
      .reverse()
      .find((rule) => rule.when.pointer === "coarse" && "--size-element-sm" in rule.tokens);
    expect(coarse?.tokens["--font-family-body"]).toBe("var(--console-font-sans)");
    expect(coarse?.tokens["--font-family-heading"]).toBe("var(--console-font-sans)");
  });

  it("raises every Astryx control to the 44px floor on a coarse pointer", () => {
    const rules = kinAstryxTheme.__adaptationRules ?? [];
    // The neutral base ships its own coarse-pointer rule for typography; the
    // floor is the rule that writes the control sizes, which is ours and is
    // appended last so it wins the ordered cascade.
    const coarse = [...rules]
      .reverse()
      .find((rule) => rule.when.pointer === "coarse" && "--size-element-sm" in rule.tokens);
    expect(coarse, "no coarse-pointer rule writing the control floor").toBeDefined();
    expect(coarse?.when).toEqual({ pointer: "coarse" });
    expect(coarse?.query).toBe("(pointer: coarse)");
    expect(COARSE_POINTER_CONTROL_FLOOR).toBe("44px");
    for (const token of ["--size-element-sm", "--size-element-md", "--size-element-lg"]) {
      expect(coarse?.tokens[token], token).toBe(COARSE_POINTER_CONTROL_FLOOR);
    }
  });

  it("pins motion to Astryx's own tempo and character", () => {
    expect(kinAstryxTheme.__axes?.motion).toMatchObject({ fast: 125, medium: 300, slow: 700 });
  });

  it("imports a stylesheet that still honours Reduce Motion", () => {
    // The provider promises reduced motion by relying on Astryx's own rules;
    // an upgrade that dropped them would make the promise silently false.
    const css = uiFile("node_modules/@astryxdesign/core/dist/astryx.css");
    const guards = css.match(/@media \(prefers-reduced-motion: reduce\)/g) ?? [];
    expect(guards.length).toBeGreaterThan(0);
  });

  it("imports a reset that maps data-theme to color-scheme", () => {
    // Astryx's Theme writes Kin's resolved scheme back to `<html data-theme>`;
    // this is the rule that turns it into the browser's own colour scheme.
    const css = uiFile("node_modules/@astryxdesign/core/src/reset.css");
    expect(css).toMatch(/:where\(html\[data-theme="light"\]\)\s*\{\s*color-scheme: light;/);
    expect(css).toMatch(/:where\(html\[data-theme="dark"\]\)\s*\{\s*color-scheme: dark;/);
  });
});

// ---------------------------------------------------------------------------
// Astryx's prose defaults vs. Kin's existing markup
// ---------------------------------------------------------------------------

/** One innermost `selector { declarations }` rule. */
interface CssRule {
  selector: string;
  declarations: Map<string, string>;
}

/** Parse the innermost rules of a CSS string. `@layer`/`@scope` wrappers are skipped. */
function parseRules(css: string): CssRule[] {
  const rules: CssRule[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].replace(/\s+/g, " ").trim();
    const declarations = new Map<string, string>();
    for (const part of match[2].split(";")) {
      const colon = part.indexOf(":");
      if (colon < 0) continue;
      declarations.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
    }
    if (declarations.size > 0) rules.push({ selector, declarations });
  }
  return rules;
}

/** The concatenated bodies of every `@layer <name> { … }` block. */
function layerBodies(css: string, layer: string): string {
  const needle = `@layer ${layer}`;
  const bodies: string[] = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(needle, from);
    if (at < 0) break;
    const open = css.indexOf("{", at);
    if (open < 0) break;
    // Skip the layer-order statement (`@layer reset, theme, base, …;`).
    if (css.slice(at + needle.length, open).trim() !== "") {
      from = open + 1;
      continue;
    }
    let depth = 0;
    let end = open;
    for (; end < css.length; end++) {
      if (css[end] === "{") depth += 1;
      else if (css[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push(css.slice(open + 1, end));
    from = end + 1;
  }
  return bodies.join("\n");
}

/**
 * Astryx prose declarations that cannot reach Kin's markup even unneutralised.
 *
 * Both are beaten by Tailwind preflight, which is in `base` — a later layer
 * than Astryx's `reset` — and, for `code`/`pre`, carries element specificity
 * against Astryx's zero-specificity `:where`.
 */
const PROSE_DECLARATIONS_ALREADY_INERT: Record<string, { properties: string[]; reason: string }> = {
  ":where(hr)": {
    properties: ["border", "border-top"],
    reason:
      "Preflight's `hr` rule sets border-top-width and its universal rule sets the other border longhands, both in `base` above Astryx's `reset`.",
  },
  ":where(code, pre)": {
    properties: ["font-family", "font-size"],
    reason:
      "Preflight's element-specific mono rule is in `base` above Astryx's reset-layer `:where` rule.",
  },
};

/** `:where(a, b)` → `["a", "b"]`; any other selector is one entry. */
function expandSelector(selector: string): string[] {
  const match = /^:where\((.*)\)$/.exec(selector);
  if (!match) return [selector];
  return match[1].split(",").map((part) => part.trim());
}

describe("Astryx prose defaults", () => {
  const indexCss = uiFile("src/index.css");
  const baseLayer = layerBodies(indexCss, "base");
  const neutralisers = new Map<string, Map<string, string>>();
  for (const rule of parseRules(baseLayer)) {
    for (const selector of expandSelector(rule.selector)) {
      neutralisers.set(selector, rule.declarations);
    }
  }
  const prose = parseRules(generateThemeCSS(kinAstryxTheme).prose);

  it("are the bare elements Astryx styles, not an empty list", () => {
    // If Astryx stops emitting prose, the neutraliser below becomes dead code
    // and this fails loudly instead of the contract silently disappearing.
    expect(prose.length).toBeGreaterThan(0);
    expect(prose.map((rule) => rule.selector)).toContain(":where(p)");
  });

  it("are neutralised in index.css so a bare element keeps inheriting", () => {
    const uncovered: string[] = [];
    for (const rule of prose) {
      const inert = PROSE_DECLARATIONS_ALREADY_INERT[rule.selector]?.properties ?? [];
      const live = [...rule.declarations.keys()].filter((property) => !inert.includes(property));
      for (const selector of expandSelector(rule.selector)) {
        const neutraliser = neutralisers.get(selector);
        if (!neutraliser) {
          if (live.length > 0) {
            uncovered.push(`${rule.selector}: no \`${selector}\` rule in index.css @layer base`);
          }
          continue;
        }
        for (const property of live) {
          if (neutraliser.get(property) !== "inherit") {
            uncovered.push(`${rule.selector} { ${property} }`);
          }
        }
      }
    }
    expect(uncovered, "Astryx prose defaults that would repaint Kin's markup").toEqual([]);
  });

  it("keeps the inert-declaration allowlist honest", () => {
    const selectors = new Set(prose.map((rule) => rule.selector));
    for (const [selector, entry] of Object.entries(PROSE_DECLARATIONS_ALREADY_INERT)) {
      expect(selectors.has(selector), `${selector} is no longer an Astryx prose selector`).toBe(
        true,
      );
      expect(entry.reason.length, `${selector} has no reason`).toBeGreaterThan(20);
    }
  });

  it("leaves inherited ink and size to the parent, which is the reported defect", () => {
    // `<div class="text-kin-red-ink"><p>{error}</p></div>` and
    // `<div class="text-body text-kin-secondary"><p>…</p></div>` lost the
    // parent's colour and size to Astryx's direct `p` declarations.
    expect(neutralisers.get("p")?.get("color")).toBe("inherit");
    expect(neutralisers.get("p")?.get("font-size")).toBe("inherit");
    expect(neutralisers.get("p")?.get("font-family")).toBe("inherit");
    expect(neutralisers.get("p")?.get("line-height")).toBe("inherit");
  });
});

// ---------------------------------------------------------------------------
// Provider behaviour
// ---------------------------------------------------------------------------

/** What Astryx's own context resolves, read through its public hooks. */
function LocaleProbe(): ReactNode {
  const locale = useAstryxLocale();
  const translate = useTranslator();
  return createElement(
    "span",
    { "data-testid": "astryx-locale" },
    `${locale}|${translate("@astryx.pagination.next")}`,
  );
}

function probeText(): string {
  return document.querySelector('[data-testid="astryx-locale"]')?.textContent ?? "";
}

describe("AstryxProvider", () => {
  const originalLocale = getLocale();

  afterEach(() => {
    act(() => setLocale(originalLocale));
  });

  it("mounts the Kin theme as Astryx's root and follows scheme changes live", async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    const { container } = render(
      createElement(AstryxProvider, null, createElement("span", null, "child")),
    );
    // The wrapper adds no layout box (`display: contents`) but it is the
    // element Astryx's @scope'd CSS hangs from.
    const wrapper = container.querySelector('[data-astryx-theme="kin"]');
    expect(wrapper, "Astryx's Theme wrapper").not.toBeNull();
    expect(wrapper?.getAttribute("data-theme")).toBe("dark");

    await act(async () => {
      document.documentElement.setAttribute("data-theme", "light");
      await Promise.resolve();
    });
    await waitFor(() => expect(wrapper?.getAttribute("data-theme")).toBe("light"));
  });

  it("hands a live locale change to Astryx without remounting", async () => {
    act(() => setLocale("zh"));
    render(createElement(AstryxProvider, null, createElement(LocaleProbe)));
    // The zh-CN generated catalog is passed through, so the key resolves to
    // its shipped Chinese string rather than the English fallback.
    expect(probeText()).toBe("zh-CN|转到下一页");

    act(() => setLocale("en"));
    await waitFor(() => expect(probeText()).toMatch(/^en\|/));
    expect(probeText()).not.toContain("转到下一页");
  });
});

describe("astryxLocaleFor", () => {
  it("maps Kin's two locales to the catalog Astryx actually ships", () => {
    expect(astryxLocaleFor("zh")).toBe("zh-CN");
    expect(astryxLocaleFor("en")).toBe("en");
  });

  it("falls back to the shipped English catalog for anything else", () => {
    expect(astryxLocaleFor("fr")).toBe("en");
    expect(astryxLocaleFor("")).toBe("en");
  });
});
