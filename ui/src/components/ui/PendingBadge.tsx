import { useT } from "../../i18n/react";

/**
 * The row-end marker for work waiting on the reader.
 *
 * It replaces the inbox: a conversation that has a pending approval or question
 * says so on its own row, and the whole row stays the only click target — the
 * badge is not a second button that would compete with "open the conversation".
 * The count is a mark, not a control.
 *
 * The visible number caps at 9+ to keep the row's tail narrow; the accessible
 * name carries the real count, because "9+" is a layout decision and "twelve
 * waiting" is the fact.
 */
export default function PendingBadge({
  count,
  className = "",
}: {
  count: number;
  /** Layout only: where the caller needs to nudge it inside its row. */
  className?: string;
}) {
  const tr = useT();
  if (count <= 0) return null;
  return (
    <span
      className={[
        "inline-flex h-[18px] min-w-[18px] flex-none items-center justify-center rounded-full bg-kin-orange px-1.5 text-caption font-bold leading-flush text-kin-on-status tabular-nums",
        className,
      ].join(" ")}
    >
      <span aria-hidden>{count > 9 ? "9+" : count}</span>
      <span className="sr-only">{tr("sessions.pendingApprovals", { count: String(count) })}</span>
    </span>
  );
}
