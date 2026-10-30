import type { Approval } from "../api/client";

/** Translator compatible with useT / i18n. */
export type AttributionT = (key: string, vars?: Record<string, string | number>) => string;

/**
 * The channel a decision came through, in words.
 *
 * `decided_via` is an audit token, not copy: `web`, `timeout`, `interrupt`,
 * `ios:<device-id>`, or whatever `X-Client-Type` an integration sent (A2A,
 * `mcp:<client>`). Rendering it raw puts a device id or an internal prefix in
 * front of a person, and "Decided via ios:node-abc123" is not an answer to
 * "who answered this". Each known family gets its own sentence; an unknown
 * token is still reported with its raw value, because a new integration
 * showing up ugly is better than an answer that claims to know the channel
 * when this table has never heard of it.
 */
export function approvalViaLabel(via: string, tr: AttributionT): string {
  const token = via.trim();
  if (!token) return tr("approval.decidedFallback");
  if (token === "web") return tr("approval.viaWeb");
  if (token === "timeout") return tr("approval.viaTimeout");
  if (token === "device_disconnected") return tr("approval.viaDisconnected");
  if (token === "interrupt") return tr("approval.viaInterrupt");
  if (token === "a2a") return tr("approval.viaA2A");
  if (token === "ios" || token.startsWith("ios:")) return tr("approval.viaPhone");
  if (token === "mcp" || token.startsWith("mcp:")) {
    const client = token.slice(4).trim();
    return client ? tr("approval.viaMcp", { client }) : tr("approval.viaMcpUnknown");
  }
  return tr("approval.viaOther", { via: token });
}

/**
 * Format approval card attribution: worker label + step/id when present,
 * otherwise parent task agent (historical rows) and optional title.
 */
export function formatApprovalAttribution(
  approval: Pick<
    Approval,
    "execution_agent" | "execution_step" | "execution_id" | "task_agent" | "task_title"
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
