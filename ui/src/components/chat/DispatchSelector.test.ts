import { describe, expect, it } from "vitest";
import {
  defaultDispatchSelection,
  isDispatchReady,
  type DispatchSelection,
} from "./DispatchSelector";

describe("defaultDispatchSelection", () => {
  it("returns an empty dispatch selection", () => {
    const sel = defaultDispatchSelection();
    expect(sel).toEqual({});
  });
});

describe("isDispatchReady", () => {
  it("returns true when mode is unset (routing not configured)", () => {
    expect(isDispatchReady({})).toBe(true);
    expect(isDispatchReady({ mode: "" })).toBe(true);
  });

  it("returns false when preview is blocked", () => {
    const sel: DispatchSelection = { mode: "auto", team: "t1" };
    expect(isDispatchReady(sel, true)).toBe(false);
  });

  // -- Auto mode --
  it("auto mode: returns false when team is not selected", () => {
    expect(isDispatchReady({ mode: "auto" })).toBe(false);
    expect(isDispatchReady({ mode: "auto", team: "" })).toBe(false);
  });

  it("auto mode: returns true when team is selected", () => {
    expect(isDispatchReady({ mode: "auto", team: "t1" })).toBe(true);
  });

  it("auto mode: returns true with team and objective", () => {
    expect(isDispatchReady({ mode: "auto", team: "t1", objective: "cost-min" })).toBe(true);
  });

  // -- Manual mode --
  it("manual mode: returns false when agent is missing", () => {
    expect(isDispatchReady({ mode: "manual" })).toBe(false);
  });

  it("manual mode: returns false when provider is missing", () => {
    expect(isDispatchReady({ mode: "manual", agent: "claude-code" })).toBe(false);
  });

  it("manual mode: returns false when model is missing", () => {
    expect(isDispatchReady({ mode: "manual", agent: "claude-code", provider: "prov-a" })).toBe(false);
  });

  it("manual mode: returns true when agent, provider, and model are all set", () => {
    expect(
      isDispatchReady({ mode: "manual", agent: "claude-code", provider: "prov-a", model: "m1" }),
    ).toBe(true);
  });

  // -- previewBlocked overrides --
  it("manual mode: previewBlocked overrides a fully filled selection", () => {
    const sel: DispatchSelection = { mode: "manual", agent: "claude-code", provider: "prov-a", model: "m1" };
    expect(isDispatchReady(sel, true)).toBe(false);
  });
});
