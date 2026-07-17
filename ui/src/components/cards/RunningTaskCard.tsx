import {
  formatCost,
  formatElapsed,
  isTerminal,
  type Task,
} from "../../api/client";
import { IconTerminal } from "../icons";

type Props = {
  task: Task;
  selected?: boolean;
  degraded?: boolean;
  now?: number;
  onClick?: () => void;
  /** Compact meta line under title (e.g. last tool action). */
  activity?: string;
};

export default function RunningTaskCard({
  task,
  selected,
  degraded,
  now = Date.now(),
  onClick,
  activity,
}: Props) {
  const terminal = isTerminal(task.status);
  const waiting = task.status === "waiting_approval";
  const live = !terminal && !degraded;

  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "w-full text-left rounded-[12px] overflow-hidden transition-shadow",
        selected
          ? "border border-kin-blue/50 bg-gradient-to-b from-[rgba(10,132,255,.1)] to-[rgba(10,132,255,.02)] shadow-card-blue"
          : live
            ? "border border-kin-blue/40 bg-gradient-to-b from-[rgba(10,132,255,.07)] to-[rgba(10,132,255,.02)]"
            : "border border-[var(--kin-hairline-strong)] bg-kin-elevated",
        onClick ? "cursor-pointer" : "cursor-default",
      ].join(" ")}
    >
      <div className="px-3.5 py-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={[
              "w-2 h-2 rounded-full flex-none",
              degraded
                ? "bg-kin-muted"
                : waiting
                  ? "bg-kin-orange"
                  : live
                    ? "bg-kin-blue animate-breathe"
                    : "bg-kin-green",
            ].join(" ")}
          />
          <span className="text-[14px] font-semibold text-kin-text truncate">
            {task.title || task.prompt}
          </span>
          <span className="text-[10.5px] font-semibold tracking-wide text-kin-blue bg-kin-blue-soft rounded px-1.5 py-0.5 flex-none">
            {task.agent}
          </span>
          <span className="ml-auto text-[12px] text-kin-tertiary tabular-nums flex-none whitespace-nowrap">
            {degraded ? "last seen" : task.status === "queued" ? "queued" : waiting ? "waiting" : "running"}
            {" · "}
            {formatElapsed(task, now)}
            {" · "}
            {formatCost(task.cost_usd)}
          </span>
        </div>
        {activity && (
          <div className="mt-2.5 flex items-center gap-1.5 text-[12.5px] text-kin-secondary font-mono">
            <IconTerminal size={13} className="text-kin-muted flex-none" />
            <span className="truncate">{activity}</span>
          </div>
        )}
      </div>
      {live && !waiting && <div className="kin-dash" />}
    </button>
  );
}
