import { describe, expect, it } from "vitest";
import type { ReactElement } from "react";
import DeltaInline, { FileSize } from "./changedFileFace";

const LABEL = "size unknown";

/**
 * Every string in an element tree, concatenated.
 *
 * The components below are pure and return elements, so the cheapest way to
 * assert on what a reader sees is to read the tree rather than mount it: this
 * repo's whole UI suite is logic-only, with no renderer to set up.
 *
 * A component element carries its inputs in `props` and no children, so `textOf`
 * calls one when it meets it — which is also how the last case below can compare
 * `FileSize`'s answer against `DeltaInline`'s directly, rather than comparing
 * both against a third, hand-written expectation.
 */
function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  const el = node as ReactElement<{ children?: unknown }> & { type?: unknown };
  if (typeof el.type === "function") {
    return textOf((el.type as (props: unknown) => unknown)(el.props));
  }
  return textOf(el.props.children);
}

const size = (additions: number | null | undefined, deletions: number | null | undefined) =>
  textOf(FileSize({ additions, deletions, label: LABEL }));

describe("FileSize", () => {
  it("says the size is unknown when neither count arrived", () => {
    expect(size(null, null)).toBe(LABEL);
    // Absent and explicitly undefined are the same fact at every call site here:
    // a payload that carried no counts at all.
    expect(size(undefined, undefined)).toBe(LABEL);
  });

  it("does not print ±0 for a pair where one count never arrived", () => {
    // The zero standing in for the missing count would be the entire display, so
    // `±0` would assert a fact about a payload that said nothing about that side.
    expect(size(null, 0)).toBe(LABEL);
    expect(size(0, null)).toBe(LABEL);
  });

  it("keeps the count it does have when the other side is missing", () => {
    expect(size(null, 5)).toBe("−5");
    expect(size(3, null)).toBe("+3");
  });

  it("still prints ±0 for a pair that really is zero on both sides", () => {
    expect(size(0, 0)).toBe("±0");
  });

  it("prints both counts when both arrived", () => {
    expect(size(3, 5)).toBe("+3 −5");
  });

  it("is the same face as DeltaInline alone", () => {
    expect(textOf(DeltaInline({ additions: 3, deletions: 5 }))).toBe("+3 −5");
    expect(textOf(DeltaInline({ additions: 0, deletions: 0 }))).toBe("±0");
  });
});
