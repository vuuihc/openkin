import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * KIN-CONTINUE-005: the footer's surface and its clearance are one source.
 *
 * jsdom computes no `backdrop-filter` and no media query, so these are source
 * properties, read the way `zen.test.ts` and `topInset.test.ts` read theirs:
 *
 * - The reduced-transparency and no-backdrop-filter fallback is near-opaque
 *   (0.94) and scoped to `[data-phone-footer]`, not a loosening of the shared
 *   `.kin-glass` value other surfaces rely on.
 * - The footer no longer paints the opaque sidebar colour.
 * - The pages that scroll under the bar all reserve the same clearance, and
 *   that clearance is derived from the bar geometry declared once in
 *   `index.css`.
 */
const UI = fileURLToPath(new URL("../../..", import.meta.url));

function source(path: string): string {
  return readFileSync(join(UI, path), "utf8");
}

describe("KIN-CONTINUE-005 footer glass", () => {
  it("KIN-CONTINUE-005 keeps a near-opaque fallback under reduced transparency and no backdrop-filter", () => {
    const css = source("src/index.css");

    // One geometry source: gap + bar + breathing room.
    expect(css).toMatch(/--phone-footer-gap:\s*8px;/);
    expect(css).toMatch(/--phone-footer-bar:\s*54px;/);
    expect(css).toMatch(
      /--phone-footer-clearance:\s*calc\(\s*var\(--phone-footer-bar\)\s*\+\s*var\(--phone-footer-gap\)\s*\+\s*12px\s*\)/,
    );

    // The footer's fallback is its own rule. Both the feature query and the
    // user preference land on the same near-opaque surface.
    expect(css).toMatch(
      /\[data-phone-footer\][^{]*\{[^}]*background:\s*rgb\(var\(--kin-panel-rgb\)\s*\/\s*0\.94\)/,
    );
    // The border is what separates the bar from content once the blur is gone.
    expect(css).toMatch(/\[data-phone-footer\][^{]*\{[^}]*border:\s*1px solid/);
    // The signed 22px frame corner, kept out of the radius ladder on purpose.
    expect(css).toMatch(/\[data-phone-footer\][^{]*\{[^}]*border-radius:\s*22px/);
    // The shared 0.98/0.74 values stay untouched for every other surface.
    expect(css).toMatch(/\.kin-glass\s*\{[^}]*0\.74/);

    // And the clearance class is phone-only, consuming the one variable.
    expect(css).toMatch(
      /@media \(max-width: 767\.98px\)[\s\S]*?\.phone-footer-clearance\s*\{[^}]*padding-bottom:\s*var\(--phone-footer-clearance\)/,
    );
  });

  it("KIN-CONTINUE-005 paints the bar with the glass and every scrolling root clears it", () => {
    const footer = source("src/components/layout/PhoneFooter.tsx");
    expect(footer).toContain("kin-glass");
    expect(footer).not.toContain("bg-kin-sidebar");
    expect(footer).toContain("var(--phone-footer-bar)");

    // The list, routines and settings all read the same clearance; none of
    // them invents its own bottom padding.
    for (const file of [
      "src/components/mobile/MobileList.tsx",
      "src/pages/RoutinesPage.tsx",
      "src/pages/SettingsPage.tsx",
    ]) {
      expect(source(file), `${file} clears the floating footer`).toContain(
        "phone-footer-clearance",
      );
    }
  });
});
