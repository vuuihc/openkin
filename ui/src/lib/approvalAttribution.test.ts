import { describe, expect, it } from "vitest";
import { approvalViaLabel, formatApprovalAttribution } from "./approvalAttribution";

const tr = (key: string, vars?: Record<string, string | number>) => {
  if (key === "inbox.fromWorker") return `From worker ${vars?.agent}`;
  if (key === "inbox.step") return `step ${vars?.n}`;
  if (key === "inbox.execution") return `execution ${vars?.id}`;
  return key;
};

describe("formatApprovalAttribution", () => {
  it("shows worker label with step and short execution id", () => {
    const label = formatApprovalAttribution(
      {
        execution_agent: "codex",
        execution_step: 2,
        execution_id: "01EXECLONGID0000000001",
        task_agent: "kin",
        task_title: "Investigate",
      },
      tr,
    );
    expect(label).toContain("From worker codex");
    expect(label).toContain("step 2");
    expect(label).toContain("execution 01EXECLO…");
    expect(label).toContain("Investigate");
  });

  it("falls back to host task agent for historical rows", () => {
    const label = formatApprovalAttribution(
      {
        task_agent: "claude-code",
        task_title: "Legacy",
      },
      tr,
    );
    expect(label).toBe("claude-code · Legacy");
  });

  it("does not label a step-zero host execution as a worker", () => {
    const label = formatApprovalAttribution(
      {
        execution_agent: "claude-code",
        execution_step: 0,
        execution_id: "01HOSTEXEC000000000001",
        task_agent: "claude-code",
        task_title: "T",
      },
      tr,
    );
    expect(label).toBe("claude-code · T");
  });
});

// KIN-CONTINUE-001, step 6: `decided_via` is an audit token. The card owes the
// reader words, not the token — and never a device id.
const viaTr = (key: string, vars?: Record<string, string | number>) => {
  if (key === "approval.viaMcp") return `Decided via ${vars?.client}`;
  if (key === "approval.viaOther") return `Decided via ${vars?.via}`;
  const table: Record<string, string> = {
    "approval.decidedFallback": "Decided",
    "approval.viaWeb": "Decided online",
    "approval.viaTimeout": "Decided by timeout",
    "approval.viaInterrupt": "Denied when the run stopped",
    "approval.viaDisconnected": "Decided when the device disconnected",
    "approval.viaA2A": "Decided through an agent connection",
    "approval.viaPhone": "Decided on a paired phone",
    "approval.viaMcpUnknown": "Decided via an MCP client",
  };
  return table[key] ?? key;
};

describe("approvalViaLabel", () => {
  it("keeps the channels the record has always written", () => {
    expect(approvalViaLabel("web", viaTr)).toBe("Decided online");
    expect(approvalViaLabel("timeout", viaTr)).toBe("Decided by timeout");
    expect(approvalViaLabel("interrupt", viaTr)).toBe("Denied when the run stopped");
    expect(approvalViaLabel("device_disconnected", viaTr)).toBe(
      "Decided when the device disconnected",
    );
  });

  it("names an A2A decision as an agent connection, not the token", () => {
    expect(approvalViaLabel("a2a", viaTr)).toBe("Decided through an agent connection");
  });

  it("names the MCP client that decided, without the prefix", () => {
    expect(approvalViaLabel("mcp:Claude Desktop", viaTr)).toBe("Decided via Claude Desktop");
    // A bare `mcp` has no client to name; the sentence still says how.
    expect(approvalViaLabel("mcp:", viaTr)).toBe("Decided via an MCP client");
    expect(approvalViaLabel("mcp", viaTr)).toBe("Decided via an MCP client");
  });

  it("does not put a device id in front of a person", () => {
    expect(approvalViaLabel("ios:node-7f3a", viaTr)).toBe("Decided on a paired phone");
    expect(approvalViaLabel("ios", viaTr)).toBe("Decided on a paired phone");
  });

  it("reports an unknown channel instead of guessing at it", () => {
    expect(approvalViaLabel("future-client", viaTr)).toBe("Decided via future-client");
  });

  it("says only 'decided' when the row carries no channel", () => {
    expect(approvalViaLabel("", viaTr)).toBe("Decided");
    expect(approvalViaLabel("   ", viaTr)).toBe("Decided");
  });
});
