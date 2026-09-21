export type TaskCardTone =
  | "running"
  | "approval"
  | "completed"
  | "failed"
  | "canceled"
  | "stale";

export type TaskCardStatusView = {
  tone: TaskCardTone;
  labelKey: string;
  dotClass: string;
  iconClass: string;
  containerClass: string;
  selectedClass: string;
  animated: boolean;
};

export function taskCardStatusView(
  status: string,
  degraded = false,
): TaskCardStatusView {
  if (degraded) {
    return makeView("stale", "task.statusLastSeen", false);
  }
  if (status === "waiting_approval" || status === "waiting_input") {
    return makeView(
      "approval",
      status === "waiting_input"
        ? "task.statusWaitingInput"
        : "task.statusWaitingApproval",
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

function makeView(
  tone: TaskCardTone,
  labelKey: string,
  animated: boolean,
): TaskCardStatusView {
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
    iconClass: "text-kin-blue",
    containerClass:
      "border border-kin-blue/40 bg-gradient-to-b from-[rgba(10,132,255,.07)] to-[rgba(10,132,255,.02)]",
    selectedClass:
      "border border-kin-blue/50 bg-gradient-to-b from-[rgba(10,132,255,.1)] to-[rgba(10,132,255,.02)] shadow-card-blue",
  },
  approval: {
    dotClass: "bg-kin-orange",
    iconClass: "text-kin-orange",
    containerClass:
      "border border-[rgba(255,159,10,.55)] bg-gradient-to-b from-[rgba(255,159,10,.1)] to-[rgba(255,159,10,.03)] shadow-card-amber",
    selectedClass:
      "border border-[rgba(255,159,10,.7)] bg-gradient-to-b from-[rgba(255,159,10,.14)] to-[rgba(255,159,10,.04)] shadow-card-amber",
  },
  completed: {
    dotClass: "bg-kin-green",
    iconClass: "text-kin-green",
    containerClass:
      "border border-kin-green/30 bg-gradient-to-b from-[rgba(48,209,88,.08)] to-[rgba(48,209,88,.02)]",
    selectedClass:
      "border border-kin-green/45 bg-gradient-to-b from-[rgba(48,209,88,.12)] to-[rgba(48,209,88,.03)]",
  },
  failed: {
    dotClass: "bg-kin-red",
    iconClass: "text-kin-red",
    containerClass:
      "border border-kin-red/35 bg-gradient-to-b from-[rgba(255,69,58,.08)] to-[rgba(255,69,58,.02)]",
    selectedClass:
      "border border-kin-red/50 bg-gradient-to-b from-[rgba(255,69,58,.12)] to-[rgba(255,69,58,.03)]",
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
