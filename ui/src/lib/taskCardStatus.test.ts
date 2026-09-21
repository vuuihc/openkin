import { describe, expect, it } from "vitest";
import { taskCardStatusView } from "./taskCardStatus";

describe("taskCardStatusView", () => {
  it("maps active task statuses to the running tone", () => {
    expect(taskCardStatusView("running")).toMatchObject({
      tone: "running",
      labelKey: "task.statusRunning",
      animated: true,
    });
    expect(taskCardStatusView("queued")).toMatchObject({
      tone: "running",
      labelKey: "task.statusQueued",
      animated: true,
    });
  });

  it("maps approval waits to the approval tone", () => {
    expect(taskCardStatusView("waiting_approval")).toMatchObject({
      tone: "approval",
      labelKey: "task.statusWaitingApproval",
      animated: false,
    });
    expect(taskCardStatusView("waiting_input")).toMatchObject({
      tone: "approval",
      labelKey: "task.statusWaitingInput",
      animated: false,
    });
  });

  it("maps terminal statuses to completed or failed tones", () => {
    expect(taskCardStatusView("succeeded")).toMatchObject({
      tone: "completed",
      labelKey: "task.statusCompleted",
    });
    expect(taskCardStatusView("failed")).toMatchObject({
      tone: "failed",
      labelKey: "task.statusFailed",
    });
    const canceled = taskCardStatusView("canceled");
    expect(canceled).toMatchObject({
      tone: "canceled",
      labelKey: "task.statusCanceled",
    });
    expect(canceled.dotClass).toBe("bg-kin-muted");
    expect(canceled.iconClass).toBe("text-kin-muted");
  });

  it("labels retrying as an active running state", () => {
    expect(taskCardStatusView("retrying")).toMatchObject({
      tone: "running",
      labelKey: "task.statusRetrying",
      animated: true,
    });
  });

  it("uses stale tone for degraded non-terminal cards", () => {
    expect(taskCardStatusView("running", true)).toMatchObject({
      tone: "stale",
      labelKey: "task.statusLastSeen",
      animated: false,
    });
  });
});
