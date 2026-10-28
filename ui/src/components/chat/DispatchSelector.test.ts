import { describe, expect, it } from "vitest";
import {
  defaultDispatchSelection,
  dispatchBlocksSend,
  getDispatchSummary,
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
    expect(isDispatchReady({ mode: "manual", agent: "claude-code", provider: "prov-a" })).toBe(
      false,
    );
  });

  it("manual mode: returns true when agent, provider, and model are all set", () => {
    expect(
      isDispatchReady({ mode: "manual", agent: "claude-code", provider: "prov-a", model: "m1" }),
    ).toBe(true);
  });

  // -- previewBlocked overrides --
  it("manual mode: previewBlocked overrides a fully filled selection", () => {
    const sel: DispatchSelection = {
      mode: "manual",
      agent: "claude-code",
      provider: "prov-a",
      model: "m1",
    };
    expect(isDispatchReady(sel, true)).toBe(false);
  });
});

describe("getDispatchSummary", () => {
  const tr = (path: string) => {
    const messages: Record<string, string> = {
      "dispatch.label": "分发",
      "dispatch.auto": "自动",
      "dispatch.manual": "手动",
      "settings.routing.objectiveBalanced": "均衡",
    };
    return messages[path] ?? path;
  };

  const options = {
    teams: [{ id: "core", name: "Core", enabled: true }],
    agents: [{ id: "claude-code", name: "Claude Code", supported_kinds: ["anthropic"] }],
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        kind: "anthropic",
        enabled: true,
        supports_agents: ["claude-code"],
        models: [],
      },
    ],
  };

  it("uses localized label when dispatch mode is unset", () => {
    expect(getDispatchSummary({}, options, tr)).toBe("分发");
  });

  it("uses localized auto label in auto mode summary", () => {
    expect(
      getDispatchSummary({ mode: "auto", team: "core", objective: "balanced" }, options, tr),
    ).toBe("自动 · Core · 均衡");
  });

  it("uses localized manual label in manual mode summary", () => {
    expect(
      getDispatchSummary(
        { mode: "manual", agent: "claude-code", provider: "anthropic", model: "sonnet" },
        options,
        tr,
      ),
    ).toBe("手动 · Claude Code · Anthropic · sonnet");
  });
});

describe("dispatchBlocksSend", () => {
  it("does not block when routing is unconfigured", () => {
    expect(dispatchBlocksSend({})).toBe(false);
  });

  it("blocks a local send whose selection is incomplete", () => {
    expect(dispatchBlocksSend({ mode: "auto" })).toBe(true);
    expect(dispatchBlocksSend({ mode: "auto", team: "t1" }, { previewBlocked: true })).toBe(true);
    expect(dispatchBlocksSend({ mode: "manual", agent: "claude-code" })).toBe(true);
  });

  it("does not block a complete local send", () => {
    expect(dispatchBlocksSend({ mode: "auto", team: "t1" })).toBe(false);
    expect(
      dispatchBlocksSend({ mode: "manual", agent: "a", provider: "p", model: "m" }),
    ).toBe(false);
  });

  // The regression this helper exists for: a default team from settings keeps
  // `mode` at "auto" for the whole draft, but the control is hidden once a
  // remote machine is chosen, so a blocking check made every remote send fail
  // with "dispatch incomplete" and no way to clear it. The same selection that
  // blocks here must not block there.
  it("never blocks a send to another machine", () => {
    const sel: DispatchSelection = { mode: "auto" };
    expect(dispatchBlocksSend(sel, { remote: true })).toBe(false);
    expect(dispatchBlocksSend(sel, { remote: true, previewBlocked: true })).toBe(false);
    expect(dispatchBlocksSend({ mode: "manual" }, { remote: true })).toBe(false);
    // …while the identical selection still blocks the same send run here.
    expect(dispatchBlocksSend(sel)).toBe(true);
  });
});
