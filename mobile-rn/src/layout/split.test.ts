import { describe, expect, it } from "@jest/globals";
import { SPLIT_LIST_WIDTH, SPLIT_MIN_WIDTH, splitFor } from "./split";

/**
 * KIN-MOBILE-001 R3 — the list's split decision.
 *
 * KIN-CONTINUE-007's 各面差异 row hands the 820 coarse-pointer surface the same
 * 304px left column as the web console and says it is not a third skin. The
 * boundary is one named constant; a mutant in `split.test.ts.mutants.json`
 * moves it so these cases cannot pass by accident.
 */

describe("KIN-MOBILE-001: the list's split decision", () => {
  it("KIN-MOBILE-001: a 767pt window is the phone stack", () => {
    expect(splitFor(767)).toEqual({ mode: "stack" });
  });

  it("KIN-MOBILE-001: a 768pt window splits into a 304pt list and the conversation", () => {
    expect(SPLIT_MIN_WIDTH).toBe(768);
    expect(SPLIT_LIST_WIDTH).toBe(304);
    expect(splitFor(768)).toEqual({ mode: "split", listWidth: 304 });
  });

  it("KIN-MOBILE-001: the signed 820pt iPad surface splits", () => {
    expect(splitFor(820)).toEqual({ mode: "split", listWidth: 304 });
  });

  it("KIN-MOBILE-001: a 390pt phone is still the stack", () => {
    expect(splitFor(390)).toEqual({ mode: "stack" });
  });
});
