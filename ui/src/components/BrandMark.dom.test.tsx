// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import BrandMark, { BRAND_MARK_PATH } from "./BrandMark";

/**
 * The boot screen paints the Kin tile in `ui/index.html` before React exists;
 * `BrandMark` paints the same tile once the console is running. Two copies of
 * one identity is a drift waiting to happen, so the path and the tile colour
 * are exported and pinned against the file that ships first.
 */

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

describe("BrandMark", () => {
  it("draws the boot screen's K and the pulsing ring", () => {
    const { container } = render(<BrandMark />);
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 512 512");
    expect(container.querySelector("svg path")?.getAttribute("d")).toBe(BRAND_MARK_PATH);
    expect(container.querySelector(".kin-brand-ring")).toBeTruthy();
  });

  it("keeps its K path and tile colour in step with ui/index.html", () => {
    // The stylesheet owns the tile colour; the boot screen hard-codes it
    // because it renders before the stylesheet is parsed. Read the token out
    // of the CSS and require the same value in the HTML, so a rebrand of one
    // without the other reds here.
    const css = read("../index.css");
    const tile = /--brand-tile:\s*(#[0-9a-f]{6})\b/i.exec(css)?.[1];
    expect(tile).toBeTruthy();
    const boot = read("../../index.html");
    expect(boot).toContain(BRAND_MARK_PATH);
    expect(boot.toLowerCase()).toContain(String(tile).toLowerCase());
  });

  it("paints the tile from the stylesheet token, not the blue brand colour", () => {
    const { container } = render(<BrandMark />);
    const mark = container.querySelector(".kin-brand-mark");
    expect(mark).toBeTruthy();
    expect(mark?.className).not.toContain("bg-kin-blue");
    // No inline colour: the tile is the stylesheet's job, so light/dark and a
    // future rebrand change in one place.
    expect(mark?.getAttribute("style") ?? "").toBe("");
    const css = read("../index.css");
    expect(css).toMatch(/--brand-tile:\s*#[0-9a-f]{6}\b/i);
    expect(css).toMatch(/\.kin-brand-mark\s*\{[^}]*background:\s*var\(--brand-tile\)/);
  });
});
