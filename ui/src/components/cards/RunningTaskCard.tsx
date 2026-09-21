import {
  formatCost,
  formatElapsed,
  isTerminal,
  type Task,
} from "../../api/client";
import { useT } from "../../i18n/react";
import { IconTerminal } from "../icons";
import { displayUserPrompt } from "../../lib/attachments";
import { taskCardStatusView } from "../../lib/taskCardStatus";

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
  const tr = useT();
  const terminal = isTerminal(task.status);
  const statusView = taskCardStatusView(task.status, degraded && !terminal);
  const live = statusView.tone === "running" && !terminal;

  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "w-full text-left rounded-[12px] overflow-hidden transition-shadow",
        selected ? statusView.selectedClass : statusView.containerClass,
        onClick ? "cursor-pointer" : "cursor-default",
      ].join(" ")}
    >
      <div className="px-3.5 py-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className={[
              "w-2 h-2 rounded-full flex-none",
              statusView.dotClass,
              statusView.animated ? "animate-breathe" : "",
            ].join(" ")}
          />
          <span className="text-[14px] font-semibold text-kin-text truncate">
            {task.title || displayUserPrompt(task.prompt || "")}
          </span>
          <span className="text-[10.5px] font-semibold tracking-wide text-kin-blue bg-kin-blue-soft rounded px-1.5 py-0.5 flex-none">
            {task.agent}
          </span>
          <span className="ml-auto text-[12px] text-kin-tertiary tabular-nums flex-none whitespace-nowrap">
            {tr(statusView.labelKey)}
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
      {live && <div className="kin-dash" />}
    </button>
  );
}
