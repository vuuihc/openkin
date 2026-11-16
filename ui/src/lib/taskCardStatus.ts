export type TaskCardTone = "running" | "approval" | "completed" | "failed" | "canceled" | "stale";

export type TaskCardStatusView = {
  tone: TaskCardTone;
  labelKey: string;
  dotClass: string;
  iconClass: string;
  containerClass: string;
  selectedClass: string;
  animated: boolean;
};

export function taskCardStatusView(status: string, degraded = false): TaskCardStatusView {
  if (degraded) {
    return makeView("stale", "task.statusLastSeen", false);
  }
  if (status === "waiting_approval" || status === "waiting_input") {
    return makeView(
      "approval",
      status === "waiting_input" ? "task.statusWaitingInput" : "task.statusWaitingApproval",
      false,
    );
  }
  if (status === "succeeded") {
    return makeView("completed", "task.statusCompleted", false);
  }
  if (status === "failed") {
    return makeView("failed", "task.statusFailed", false);
  }
  if (status === "canceled") {
    return makeView("canceled", "task.statusCanceled", false);
  }
  return makeView(
    "running",
    status === "queued"
      ? "task.statusQueued"
      : status === "retrying"
        ? "task.statusRetrying"
        : "task.statusRunning",
    true,
  );
}

function makeView(tone: TaskCardTone, labelKey: string, animated: boolean): TaskCardStatusView {
  const toneClass = toneClasses[tone];
  return {
    tone,
    labelKey,
    animated,
    ...toneClass,
  };
}

const toneClasses: Record<
  TaskCardTone,
  Omit<TaskCardStatusView, "tone" | "labelKey" | "animated">
> = {
  running: {
    dotClass: "bg-kin-blue",
    iconClass: "text-kin-blue-ink",
    containerClass: "border border-kin-blue/40 bg-gradient-to-b from-kin-blue/5 to-kin-blue/5",
    selectedClass:
      "border border-kin-blue/50 bg-gradient-to-b from-kin-blue/10 to-kin-blue/5 shadow-e2",
  },
  approval: {
    dotClass: "bg-kin-orange",
    iconClass: "text-kin-orange-ink",
    containerClass:
      "border border-kin-orange/55 bg-gradient-to-b from-kin-orange/10 to-kin-orange/5 shadow-e2",
    selectedClass:
      "border border-kin-orange/70 bg-gradient-to-b from-kin-orange/15 to-kin-orange/5 shadow-e2",
  },
  completed: {
    dotClass: "bg-kin-green",
    iconClass: "text-kin-green-ink",
    containerClass: "border border-kin-green/30 bg-gradient-to-b from-kin-green/10 to-kin-green/5",
    selectedClass: "border border-kin-green/45 bg-gradient-to-b from-kin-green/15 to-kin-green/5",
  },
  failed: {
    dotClass: "bg-kin-red",
    iconClass: "text-kin-red-ink",
    containerClass: "border border-kin-red/35 bg-gradient-to-b from-kin-red/10 to-kin-red/5",
    selectedClass: "border border-kin-red/50 bg-gradient-to-b from-kin-red/15 to-kin-red/5",
  },
  canceled: {
    dotClass: "bg-kin-muted",
    iconClass: "text-kin-muted",
    containerClass: "border border-[var(--kin-hairline-strong)] bg-kin-elevated",
    selectedClass: "border border-[var(--kin-hairline-strong)] bg-kin-elevated",
  },
  stale: {
    dotClass: "bg-kin-muted",
    iconClass: "text-kin-muted",
    containerClass: "border border-[var(--kin-hairline-strong)] bg-kin-elevated",
    selectedClass: "border border-[var(--kin-hairline-strong)] bg-kin-elevated",
  },
};
