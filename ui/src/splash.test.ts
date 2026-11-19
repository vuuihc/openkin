import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The console splash is the second wait of a launch: the shell's boot page
 * has already shown the iOS wheel, and React has not mounted yet. The owner
 * overruled the K brand tile on 2026-11-19 (D13); `IosSpinner.tsx` carries the
 * same wheel inside the app, so this page copies its geometry and its
 * `steps(12, end)` tick literally. One cue, three surfaces.
 *
 * The splash must stay inside `#root`: `createRoot(...).render()` replaces it
 * on mount, and that replacement is the handover — no removal script.
 */
const HTML = readFileSync(new URL("../index.html", import.meta.url), "utf8");

/** The `{ ... }` block that starts at `opening`, braces counted so a nested
 * rule cannot end the slice early. */
function block(text: string, opening: string): string {
  const start = text.indexOf(opening);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}" && (depth -= 1) === 0) return text.slice(start, i + 1);
  }
  throw new Error(`unclosed block: ${opening}`);
}

/** The splash markup and where `#root` closes: React's mount point is what
 * makes the splash disappear, so its position is part of the contract. */
function root(): { body: string; end: number } {
  const open = HTML.indexOf('<div id="root">');
  expect(open).toBeGreaterThanOrEqual(0);
  const start = open + '<div id="root">'.length;
  let depth = 1;
  for (let i = start; i < HTML.length; i += 1) {
    if (HTML.startsWith("<div", i)) depth += 1;
    else if (HTML.startsWith("</div>", i) && (depth -= 1) === 0) {
      return { body: HTML.slice(start, i), end: i + "</div>".length };
    }
  }
  throw new Error("unclosed #root");
}

/** Each spoke's inline rotation and opacity, in document order. */
function spokes(): { rotation: number; opacity: number }[] {
  return [...HTML.matchAll(/<span\b[^>]*\bclass="kin-ios-spoke"[^>]*>/g)].map((match) => {
    const rotation = match[0].match(/rotate\((-?[\d.]+)deg\)/);
    const opacity = match[0].match(/opacity:\s*([\d.]+)/);
    expect(rotation, "a spoke has no rotation").toBeTruthy();
    expect(opacity, "a spoke has no opacity").toBeTruthy();
    return { rotation: Number(rotation?.[1]), opacity: Number(opacity?.[1]) };
  });
}

describe("the console splash", () => {
  it("draws the iOS spinner", () => {
    const wheel = spokes();
    expect(wheel).toHaveLength(12);
    wheel.forEach((spoke, index) => {
      expect(spoke.rotation).toBe(index * 30);
      // opacity: 1 - 0.85 * i / 11 — the lead is opaque, the tail fades.
      expect(spoke.opacity).toBeCloseTo(1 - (0.85 * index) / 11, 2);
    });

    // The 32 px launch size, the same as the shell's boot page.
    const wrapper = block(HTML, ".kin-ios-spinner {");
    expect(wrapper).toMatch(/width:\s*32px/);
    expect(wrapper).toMatch(/height:\s*32px/);
    const spoke = block(HTML, ".kin-ios-spoke {");
    expect(spoke).toMatch(/width:\s*2\.56px/);
    expect(spoke).toMatch(/height:\s*8px/);
    expect(spoke).toMatch(/border-radius:\s*9999px/);
    // --kin-muted-rgb dark (ui/src/design/theme.css); this page has no token layer.
    expect(spoke).toMatch(/background:\s*rgb\(152 152 157\)/);
    // --kin-muted-rgb light.
    expect(block(HTML, "html.light .kin-ios-spoke")).toMatch(/background:\s*rgb\(92 92 97\)/);

    // Twelve discrete ticks, not a smooth sweep: `linear` loses the iOS read.
    expect(HTML).toMatch(/animation:\s*kin-ios-spin\s+1s\s+steps\(12,\s*end\)\s+infinite/);
    expect(block(HTML, "@keyframes kin-ios-spin")).toMatch(/rotate\(1turn\)/);
  });

  it("keeps no brand tile", () => {
    for (const gone of ["kin-boot-mark", "kin-boot-ring", "kin-boot-pulse", "M116 116H219"]) {
      expect(HTML).not.toContain(gone);
    }
    expect(HTML).not.toMatch(/<svg\b/);
  });

  it("stops the spinner under reduced motion but keeps it visible", () => {
    const reduced = block(HTML, "@media (prefers-reduced-motion: reduce)");
    expect(reduced).toMatch(/\.kin-ios-spinner\s*\{[^}]*animation:\s*none/);
    // Still, but present: the wheel is what says "waiting", not its motion.
    expect(reduced).not.toMatch(/display:\s*none|visibility:\s*hidden|opacity:\s*0\b/);
  });

  it("keeps the splash self-contained", () => {
    const splash = root().body;
    // No origin to fetch from: the splash paints while the console bundle loads.
    expect(splash).not.toMatch(/https?:\/\//);
    expect(splash).not.toMatch(/<link\b|<script\b|<img\b/i);
    for (const match of splash.matchAll(/url\(([^)]*)\)/g)) {
      expect(match[1].trim()).toMatch(/^["']?data:/);
    }
  });

  it("stays inside #root so React replaces it on mount", () => {
    const splash = root();
    expect(splash.body).toContain('class="kin-ios-spinner"');
    // The module script is the mount point; it must run after the splash markup.
    expect(HTML.indexOf('<script type="module"')).toBeGreaterThan(splash.end);
  });
});
