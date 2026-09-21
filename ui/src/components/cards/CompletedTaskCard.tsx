import { formatCost, formatElapsed, type Task } from "../../api/client";
import { useT } from "../../i18n/react";
import { IconAlert, IconCheck, IconStar } from "../icons";
import { displayUserPrompt } from "../../lib/attachments";
import { taskCardStatusView } from "../../lib/taskCardStatus";

type Props = {
  task: Task;
  summary?: string;
  compact?: boolean;
  onClick?: () => void;
};

export default function CompletedTaskCard({
  task,
  summary,
  compact,
  onClick,
}: Props) {
  const tr = useT();
  const statusView = taskCardStatusView(task.status);
  const ok = statusView.tone === "completed";
  const meta = [
    tr(statusView.labelKey),
    task.agent,
    formatElapsed(task, task.finished_at ?? Date.now()),
    formatCost(task.cost_usd),
  ].join(" · ");
  const StatusIcon = ok ? IconCheck : IconAlert;

  if (compact) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={[
          "w-full flex items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-[var(--kin-fill-strong)]",
          statusView.containerClass,
        ].join(" ")}
      >
        <StatusIcon size={14} className={`${statusView.iconClass} flex-none`} />
        <span className="text-[13px] text-kin-text truncate flex-1">
          {task.title || displayUserPrompt(task.prompt || "")}
        </span>
        <span className="text-[11.5px] text-kin-muted tabular-nums flex-none">
          {meta}
        </span>
      </button>
    );
  }

  return (
    <div className="flex gap-2.5 items-start">
      <div className="w-[26px] h-[26px] flex-none rounded-[7px] bg-gradient-to-b from-[#3a3a3e] to-[#2a2a2e] flex items-center justify-center">
        <IconStar size={14} className={statusView.iconClass} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] text-kin-tertiary mb-2">
          {tr("task.historySection")}
        </div>
        <button
          type="button"
          onClick={onClick}
          className={[
            "w-full text-left rounded-[10px] px-3 py-2.5 hover:bg-[var(--kin-fill)]",
            statusView.containerClass,
          ].join(" ")}
        >
          <div className="flex items-center gap-2 min-w-0">
            <StatusIcon
              size={15}
              className={`${statusView.iconClass} flex-none`}
            />
            <span className="text-[13.5px] font-semibold text-kin-text truncate">
              {task.title || displayUserPrompt(task.prompt || "")}
            </span>
            <span className="ml-auto text-[11.5px] text-kin-muted tabular-nums flex-none">
              {meta}
            </span>
          </div>
          {summary && (
            <div className="mt-1.5 pl-[23px] text-[12.5px] text-kin-secondary">
              {summary}
            </div>
          )}
        </button>
      </div>
    </div>
  );
}
