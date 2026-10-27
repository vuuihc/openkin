import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import type { AtRule } from "postcss";
import { describe, expect, it } from "vitest";

/**
 * The three things that keep a phone layout the width of the phone.
 *
 * 1. iOS Safari (and the WKWebView the phone app runs in) zooms the page when a
 *    text field takes focus at under 16px, and it does not zoom back out. What
 *    the user sees is not "a small font" but a layout wider than the screen
 *    that pans left and right — it was reported as a wrong page width. Every
 *    control in this tree is drawn at 11–15px, so the fix cannot be
 *    per-component: it is the coarse-pointer floor in `index.css`, and these
 *    tests are what keep it from being deleted as a mysterious `font-size`.
 * 2. The login screen used to focus its email field on mount. That is a
 *    convenience with a mouse and an ambush on a phone: the keyboard covers the
 *    form before it has been read, and the focus is what triggers the zoom.
 * 3. Anything that still ends up wider than the viewport is clipped at the
 *    root, so it cannot be panned. `clip` and not `hidden`, because `hidden`
 *    would make the root a scroll container and take `position: sticky` with
 *    it — that difference is invisible until a sticky header stops sticking.
 *    `clip` is Safari 16+, so a `hidden` fallback stays for the iOS 15 floor
 *    the native shell declares.
 */

const UI = fileURLToPath(new URL("../..", import.meta.url));
const css = readFileSync(`${UI}/src/index.css`, "utf8");

/** The coarse-pointer blocks, in source order. There is more than one. */
function coarsePointerBlocks(): AtRule[] {
  const blocks: AtRule[] = [];
  postcss.parse(css).walkAtRules("media", (rule) => {
    if (rule.params.replace(/\s+/g, " ").trim() === "(pointer: coarse)") blocks.push(rule);
  });
  return blocks;
}

/** The block that carries the touch type floor. */
function typeFloorBlock(): AtRule {
  const block = coarsePointerBlocks().find((media) => {
    let found = false;
    media.walkDecls("font-size", (decl) => {
      if (decl.value.trim() === "16px") found = true;
    });
    return found;
  });
  if (!block) throw new Error("index.css has no coarse-pointer 16px type floor");
  return block;
}

/**
 * Every declaration that lands on `selector`, merged across the rules that
 * name it. The root rules are split in two (`html, body, #root` for the
 * sizing, `html, body` for the clipping), so one rule per selector would be
 * the wrong shape.
 */
function declarations(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  postcss.parse(css).walkRules((rule) => {
    const selectors = rule.selector.split(",").map((part) => part.trim());
    if (!selectors.includes(selector)) return;
    rule.walkDecls((decl) => {
      out.set(decl.prop.trim(), decl.value.trim());
    });
  });
  return out;
}

/**
 * The type floor's selectors, whitespace collapsed. Prettier wraps the long
 * `input:not(...)` chain across lines, so a raw selector string is not stable
 * enough to assert against.
 */
function typeFloorSelectors(): string {
  const selectors: string[] = [];
  typeFloorBlock().walkRules((rule) => {
    selectors.push(rule.selector.replace(/\s+/g, " "));
  });
  return selectors.join("\n");
}

/** The floor's selector list, one entry per comma-separated selector. */
function typeFloorParts(): string[] {
  return typeFloorSelectors()
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

describe("touch type floor", () => {
  it("raises every text control to 16px on a coarse pointer", () => {
    const parts = typeFloorParts();
    expect(parts.some((part) => part.startsWith(":root input:not("))).toBe(true);
    expect(parts).toContain(":root select");
    expect(parts).toContain(":root textarea");
    expect(parts).toContain(':root [contenteditable="true"]');
  });

  it("leaves the controls with no text to read alone", () => {
    const joined = typeFloorSelectors();
    for (const type of ["checkbox", "radio", "range", "file", "color"]) {
      expect(joined).toContain(`[type="${type}"]`);
    }
  });

  it("is not scoped to a wrapper, so a portaled dialog keeps the floor", () => {
    // The 44px floor is `.touch-lg`-scoped on purpose: it is a layout choice
    // for the phone shell. This one is a platform rule about focus, and a
    // `createPortal(…, document.body)` dialog sits outside any wrapper while
    // still taking focus. Scoping it here is how the folder picker's popover
    // would silently regrow the bug.
    expect(typeFloorSelectors()).not.toContain(".touch-lg");
  });

  it("out-specifies the type utilities these fields actually carry", () => {
    // Presence is not enough. The composer's textarea carries `text-strong`,
    // the pickers' selects carry `text-caption`, settings' fields carry
    // `kin-input` — all classes, all (0,1,0). A bare `textarea` (0,0,1) loses
    // to them and the field stays at 13px, which is the zoom this whole rule
    // exists to prevent. `:root` is what lifts every arm above a class.
    for (const part of typeFloorParts()) {
      expect(part).toMatch(/^:root /);
    }
    // The input arm is the one that does not rely on `:root` alone.
    const input = typeFloorParts().find((part) => part.startsWith(":root input"));
    expect(input?.match(/:not\(/g)?.length ?? 0).toBeGreaterThanOrEqual(6);
  });
});

describe("layout backstop", () => {
  it("clips a wide child at the viewport instead of letting it pan", () => {
    for (const selector of ["html", "body"]) {
      expect(declarations(selector).get("overflow-x")).toBe("clip");
    }
  });

  it("never lets the shell grow past the viewport", () => {
    for (const selector of ["html", "body", "#root"]) {
      expect(declarations(selector).get("max-width")).toBe("100%");
    }
  });
});

describe("touch-lg wiring", () => {
  // The 44px floor is scoped to `.touch-lg`, so a root that loses the class
  // silently switches it off for every control beneath it — and every other
  // test here would stay green. These are the three roots a field can live
  // under. (The 16px type floor is deliberately not scoped; see above.)
  const roots: Array<[string, RegExp]> = [
    ["components/layout/AppShell.tsx", /className=\{`touch-lg /],
    ["components/AccountScreen.tsx", /className="touch-lg /],
    ["components/ConnectScreen.tsx", /className="touch-lg /],
  ];
  for (const [file, onRoot] of roots) {
    it(`keeps the class on ${file}'s root`, () => {
      expect(readFileSync(`${UI}/src/${file}`, "utf8")).toMatch(onRoot);
    });
  }
});

describe("login screen focus", () => {
  const source = readFileSync(`${UI}/src/components/AccountScreen.tsx`, "utf8");

  it("never auto-focuses a field unconditionally", () => {
    // The bare attribute, and any expression that does not go through the
    // pointer check — `autoFocus={true}` is the same regression wearing a
    // different shape.
    expect(source.match(/\bautoFocus\b(?!=\{)/g) ?? []).toHaveLength(0);
    const expressions = source.match(/autoFocus=\{[^}]*\}/g) ?? [];
    expect(expressions.length).toBeGreaterThan(0);
    for (const expression of expressions) {
      expect(expression).toContain("focusOnMount");
    }
    expect(source).toContain("hasFinePointer()");
  });
});
