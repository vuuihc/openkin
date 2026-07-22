import type { Approval } from "../api/client";

/** Translator compatible with useT / i18n. */
export type AttributionT = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

/**
 * Format approval card attribution: worker label + step/id when present,
 * otherwise parent task agent (historical rows) and optional title.
 */
export function formatApprovalAttribution(
  approval: Pick<
    Approval,
    | "execution_agent"
    | "execution_step"
    | "execution_id"
    | "task_agent"
    | "task_title"
  >,
  tr: AttributionT,
): string {
  const worker =
    approval.execution_step && approval.execution_step > 0
      ? (approval.execution_agent || "").trim()
      : "";
  const parts: string[] = [];
  if (worker) {
    parts.push(tr("inbox.fromWorker", { agent: worker }));
    if (approval.execution_step && approval.execution_step > 0) {
      parts.push(tr("inbox.step", { n: approval.execution_step }));
    }
    if (approval.execution_id) {
      const short =
        approval.execution_id.length > 10
          ? `${approval.execution_id.slice(0, 8)}…`
          : approval.execution_id;
      parts.push(tr("inbox.execution", { id: short }));
    }
  } else if (approval.task_agent) {
    parts.push(approval.task_agent);
  }
  if (approval.task_title) {
    parts.push(approval.task_title);
  }
  return parts.filter(Boolean).join(" · ");
}
