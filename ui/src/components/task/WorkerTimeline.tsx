import { useT } from "../../i18n/react";
import type { WorkerStep } from "../../api/client";

type WorkerTimelineProps = {
  steps: WorkerStep[];
};

function statusKey(status: string): string {
  switch (status) {
    case "planned":
      return "task.workerStatusPlanned";
    case "running":
      return "task.workerStatusRunning";
    case "succeeded":
      return "task.workerStatusSucceeded";
    case "failed":
      return "task.workerStatusFailed";
    case "canceled":
      return "task.workerStatusCanceled";
    default:
      return "task.workerStatusUnknown";
  }
}

export default function WorkerTimeline({ steps }: WorkerTimelineProps) {
  const tr = useT();
  if (steps.length === 0) return null;

  return (
    <section
      aria-label={tr("task.workerTimeline")}
      className="mx-auto mb-5 w-full max-w-[760px] rounded-lg border border-[var(--kin-hairline)] bg-[rgba(255,255,255,.025)] px-3 py-3"
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[12px] font-semibold text-[var(--kin-text)]">
          {tr("task.workerTimeline")}
        </h2>
        <span className="text-[11px] text-[var(--kin-muted)]">
          {tr("task.workerStepCount", { n: steps.length })}
        </span>
      </div>
      <ol className="grid gap-1.5">
        {steps.map((step) => (
          <li
            key={`${step.execution_id}-${step.step_index}`}
            className="grid grid-cols-[24px_minmax(0,1fr)_auto] items-center gap-2 rounded-md px-2 py-1.5 text-[12px] hover:bg-[rgba(255,255,255,.04)]"
          >
            <span className="text-center font-mono text-[11px] text-[var(--kin-muted)]">
              {step.step_index + 1}
            </span>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium text-[var(--kin-text)]">
                  {step.agent}
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-[0.08em] text-[var(--kin-muted)]">
                  {step.access === "write"
                    ? tr("task.workerAccessWrite")
                    : tr("task.workerAccessRead")}
                </span>
              </div>
              <div className="truncate text-[11px] text-[var(--kin-muted)]">
                {step.role}
                {step.result_summary ? ` · ${step.result_summary}` : ""}
              </div>
            </div>
            <span className="shrink-0 text-[11px] text-[var(--kin-muted)]">
              {tr(statusKey(step.status))}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
