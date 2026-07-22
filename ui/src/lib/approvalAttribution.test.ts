import { describe, expect, it } from "vitest";
import { formatApprovalAttribution } from "./approvalAttribution";

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
