import { describe, expect, it } from "vitest";
import { agentFamily, agentTransport, collapseAgentVariants } from "./agentFamilies";
import { PERMISSION_MODES, permissionModesForAgent } from "./permissionMode";

describe("agentFamily", () => {
  it("knows the transports that drive the same product", () => {
    expect(agentFamily("claude-code")).toBe("claude");
    expect(agentFamily("claude-acp")).toBe("claude");
    expect(agentFamily("codex-acp")).toBe("codex");
    expect(agentFamily("pi-acp")).toBe("pi");
    expect(agentFamily("gemini")).toBe("gemini");
    expect(agentFamily("whatever", "Named")).toBe("named");
  });
});

describe("agentTransport", () => {
  it("reads the daemon's own conventions", () => {
    expect(agentTransport("claude-acp")).toBe("acp");
    expect(agentTransport("claude-code", undefined, "cli")).toBe("native");
    expect(agentTransport("gemini", undefined, "cli")).toBe("cli");
    expect(agentTransport("kin", undefined, "builtin")).toBe("native");
    expect(agentTransport("x", "acp")).toBe("acp");
  });
});

describe("collapseAgentVariants", () => {
  it("keeps one entry per family, preferring a usable native adapter", () => {
    const collapsed = collapseAgentVariants([
      { id: "claude-acp", available: true },
      { id: "claude-code", available: true },
      { id: "codex", available: true },
    ]);
    expect(collapsed.map((a) => a.id)).toEqual(["claude-code", "codex"]);
  });

  it("prefers an available entry over an unavailable one", () => {
    const collapsed = collapseAgentVariants([
      { id: "claude-code", available: false },
      { id: "claude-acp", available: true },
    ]);
    expect(collapsed.map((a) => a.id)).toEqual(["claude-acp"]);
  });

  it("leaves distinct products alone", () => {
    const agents = [
      { id: "codex", available: true },
      { id: "grok", available: true },
      { id: "gemini", available: false },
    ];
    expect(collapseAgentVariants(agents)).toEqual(agents);
  });
});

describe("permissionModesForAgent", () => {
  it("offers every mode when the source cannot say, on this machine", () => {
    expect(permissionModesForAgent(undefined, true)).toEqual(PERMISSION_MODES);
    expect(permissionModesForAgent({}, true)).toEqual(PERMISSION_MODES);
  });

  it("offers the ladder the agent itself reports, on this machine too", () => {
    // The bug this closes: an agent with a single on/off flag was shown both
    // "auto-edit" and "YOLO" for the same behaviour, and an agent that never
    // asks was shown a choice at all.
    expect(permissionModesForAgent({ permission_modes: ["default"] }, true)).toEqual(["default"]);
    expect(permissionModesForAgent({ permission_modes: ["default", "yolo"] }, true)).toEqual([
      "default",
      "yolo",
    ]);
    expect(permissionModesForAgent({ permissionModes: ["default", "accept_edits"] }, true)).toEqual([
      "default",
      "accept_edits",
    ]);
  });

  it("offers only what a remote node says it will run", () => {
    expect(permissionModesForAgent({ permission_modes: ["default"] }, false)).toEqual(["default"]);
    expect(
      permissionModesForAgent({ permissionModes: ["default", "accept_edits", "yolo"] }, false),
    ).toEqual(PERMISSION_MODES);
  });

  it("does not offer yolo to a node that did not say", () => {
    // The shape of the bug this closes: a mode persisted from another session
    // was sent to a node that refuses bypassed approvals, and the first turn
    // failed instead of the choice never being offered.
    expect(permissionModesForAgent({}, false)).toEqual(["default", "accept_edits"]);
    expect(permissionModesForAgent(undefined, false)).toEqual(["default", "accept_edits"]);
  });

  it("keeps a rung when the advertised names are all unknown", () => {
    expect(permissionModesForAgent({ permission_modes: ["plan"] }, true)).toEqual(["default"]);
    expect(permissionModesForAgent({ permission_modes: [] }, false)).toEqual(["default"]);
  });
});
