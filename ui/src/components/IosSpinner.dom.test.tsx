// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import IosSpinner from "./IosSpinner";

/**
 * The wait for a conversation's detail is the standard iOS activity indicator:
 * twelve spokes with a descending opacity, ticking around in twelve discrete
 * steps. The owner overruled the boot screen's K tile here (2026-11-19); the
 * tick is what makes the wheel read as iOS rather than as a smooth sweep, so
 * the motion is pinned to `steps(12, end)` in the stylesheet.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

/** The `{ ... }` block that starts at `opening`, counted so a nested rule
 * cannot end the slice early. */
function block(css: string, opening: string) {
  const start = css.indexOf(opening);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}" && (depth -= 1) === 0) return css.slice(start, i + 1);
  }
  throw new Error(`unclosed block: ${opening}`);
}

describe("IosSpinner", () => {
  it("draws twelve spokes and hides them from the accessibility tree", () => {
    const { container } = render(<IosSpinner />);
    const wheel = container.querySelector(".kin-ios-spinner");
    expect(wheel).toBeTruthy();
    expect(wheel?.getAttribute("aria-hidden")).toBe("true");

    const spokes = wheel?.querySelectorAll("span") ?? [];
    expect(spokes).toHaveLength(12);
    // The lead is opaque and the tail fades: the wheel's direction is the
    // opacity ladder, not an extra element.
    expect(Number((spokes[0] as HTMLElement).style.opacity)).toBe(1);
    expect(Number((spokes[11] as HTMLElement).style.opacity)).toBeCloseTo(0.15);

    // No path, no tile: the wheel is geometry.
    expect(container.querySelector("svg")).toBeNull();

    expect((wheel as HTMLElement).style.width).toBe("28px");
    expect((wheel as HTMLElement).style.height).toBe("28px");

    const sized = render(<IosSpinner size={40} />);
    const larger = sized.container.querySelector(".kin-ios-spinner") as HTMLElement;
    expect(larger.style.width).toBe("40px");
    expect(larger.style.height).toBe("40px");
  });

  it("animates in twelve steps, not a smooth sweep", () => {
    const { container } = render(<IosSpinner />);
    // The stylesheet owns the motion, so reduced-motion and the tick live in
    // one place; an inline `animation` here would outrank both.
    expect(container.innerHTML).not.toContain("animation");

    const css = read("../index.css");
    expect(css).toMatch(/@keyframes\s+kin-ios-spin\b/);
    expect(block(css, ".kin-ios-spinner {")).toMatch(
      /animation:\s*kin-ios-spin\s+1s\s+steps\(12,\s*end\)\s+infinite/,
    );

    // Reduced motion stops the tick but keeps the wheel visible: it is the
    // wait surface, not decoration.
    const reduced = block(css, "@media (prefers-reduced-motion: reduce)");
    expect(reduced).toMatch(/\.kin-ios-spinner\s*\{[^}]*animation:\s*none/);
  });
});
