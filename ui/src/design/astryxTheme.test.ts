// @vitest-environment node
/**
 * The bridge's contract.
 *
 * The point of this file is the first case: every Kin token has a decision.
 * The rest guard the shape of those decisions — that a mapping points at a real
 * Astryx token, that no Astryx token is given two Kin values, and that the two
 * floors the provider promises (44px on touch, motion unchanged) are actually
 * in the theme rather than in a comment.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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
import {
  astryxLocaleFor,
  astryxTokenValues,
  COARSE_POINTER_CONTROL_FLOOR,
  kinAstryxTheme,
  KIN_TOKEN_BINDINGS,
  kinExtensionTokens,
} from "./astryxTheme";
import { PRESENTED_TOKENS, cssValue } from "./colors";

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
    const css = readFileSync(
      new URL("../../node_modules/@astryxdesign/core/dist/astryx.css", import.meta.url),
      "utf8",
    );
    const guards = css.match(/@media \(prefers-reduced-motion: reduce\)/g) ?? [];
    expect(guards.length).toBeGreaterThan(0);
  });

  it("imports a reset that maps data-theme to color-scheme", () => {
    // Astryx's Theme writes Kin's resolved scheme back to `<html data-theme>`;
    // this is the rule that turns it into the browser's own colour scheme.
    const css = readFileSync(
      new URL("../../node_modules/@astryxdesign/core/src/reset.css", import.meta.url),
      "utf8",
    );
    expect(css).toMatch(/:where\(html\[data-theme="light"\]\)\s*\{\s*color-scheme: light;/);
    expect(css).toMatch(/:where\(html\[data-theme="dark"\]\)\s*\{\s*color-scheme: dark;/);
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
