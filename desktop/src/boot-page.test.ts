import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

/**
 * The shell's boot surface is the first thing a launch paints (#418 shows the
 * window before the daemon answers) and it stays up until the console swaps in
 * at ~1.3 s median — the longest-lived wait in the product.
 *
 * The owner overruled the K brand tile here on 2026-11-19 (D13) and asked for
 * the iOS activity indicator the console already draws in
 * `ui/src/components/IosSpinner.tsx`. This page is static (no stylesheet, no
 * script), so the wheel's geometry, its ink and its twelve-step tick are
 * copied literally; the console splash copies the same block, so the handover
 * from shell to `ui/index.html` shows one cue, not two.
 */
const PAGE = readFileSync(
  existsSync("boot.html") ? "boot.html" : "desktop/boot.html",
  "utf8",
);

/** The `{ ... }` block that starts at `opening`, braces counted so a nested
 * rule cannot end the slice early. */
function block(text: string, opening: string): string {
  const start = text.indexOf(opening);
  assert.ok(start >= 0, `missing block: ${opening}`);
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}" && (depth -= 1) === 0) return text.slice(start, i + 1);
  }
  assert.fail(`unclosed block: ${opening}`);
}

/** Each spoke's inline rotation and opacity, in document order. */
function spokes(): { rotation: number; opacity: number }[] {
  return [...PAGE.matchAll(/<span\b[^>]*\bclass="kin-ios-spoke"[^>]*>/g)].map((match) => {
    const rotation = match[0].match(/rotate\((-?[\d.]+)deg\)/);
    const opacity = match[0].match(/opacity:\s*([\d.]+)/);
    assert.ok(rotation, "a spoke has no rotation");
    assert.ok(opacity, "a spoke has no opacity");
    return { rotation: Number(rotation[1]), opacity: Number(opacity[1]) };
  });
}

describe("the boot page", () => {
  it("draws the iOS spinner", () => {
    const wheel = spokes();
    assert.equal(wheel.length, 12, "expected twelve spokes");
    wheel.forEach((spoke, index) => {
      assert.equal(spoke.rotation, index * 30, `spoke ${index} is not ${index * 30}° round`);
      // opacity: 1 - 0.85 * i / 11 — the lead is opaque, the tail fades.
      assert.ok(
        Math.abs(spoke.opacity - (1 - (0.85 * index) / 11)) < 0.01,
        `spoke ${index} opacity ${spoke.opacity} is not the iOS ladder`,
      );
    });

    // The 32 px launch size: 8% spokes, 25% height, 32% radius.
    const wrapper = block(PAGE, ".kin-ios-spinner {");
    assert.match(wrapper, /width:\s*32px/);
    assert.match(wrapper, /height:\s*32px/);
    const spoke = block(PAGE, ".kin-ios-spoke {");
    assert.match(spoke, /width:\s*2\.56px/);
    assert.match(spoke, /height:\s*8px/);
    assert.match(spoke, /border-radius:\s*9999px/);
    // --kin-muted-rgb (ui/src/design/theme.css); this page has no token layer.
    assert.match(spoke, /background:\s*rgb\(152 152 157\)/);

    // Twelve discrete ticks, not a smooth sweep: `linear` loses the iOS read.
    assert.match(PAGE, /animation:\s*kin-ios-spin\s+1s\s+steps\(12,\s*end\)\s+infinite/);
    assert.match(block(PAGE, "@keyframes kin-ios-spin"), /rotate\(1turn\)/);
  });

  it("keeps no brand tile", () => {
    for (const gone of ["kin-boot-mark", "kin-boot-ring", "kin-boot-pulse", "M116 116H219"]) {
      assert.ok(!PAGE.includes(gone), `the boot page still contains ${gone}`);
    }
    assert.doesNotMatch(PAGE, /<svg\b/);
  });

  it("stops the spinner under reduced motion but keeps it visible", () => {
    const reduced = block(PAGE, "@media (prefers-reduced-motion: reduce)");
    assert.match(reduced, /\.kin-ios-spinner\s*\{[^}]*animation:\s*none/);
    // Still, but present: the wheel is what says "waiting", not its motion.
    assert.doesNotMatch(reduced, /display:\s*none|visibility:\s*hidden|opacity:\s*0\b/);
  });

  it("stays self-contained", () => {
    // No origin to fetch from: the page has to paint before the daemon exists.
    assert.doesNotMatch(PAGE, /https?:\/\//);
    assert.doesNotMatch(PAGE, /<link\b|<script\b|<img\b/i);
    for (const [, url] of PAGE.matchAll(/url\(([^)]*)\)/g)) {
      assert.match(url.trim(), /^["']?data:/, `external url(): ${url}`);
    }
    // Inline style is the only thing the CSP lets through besides data: images.
    assert.match(
      PAGE,
      /http-equiv="Content-Security-Policy"\s+content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"/,
    );
  });
});
