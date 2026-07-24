import {
  cancelTask,
  formatCost,
  formatElapsed,
  isTerminal,
  type Task,
  type TaskEvent,
} from "../../api/client";
import { useAppStore } from "../../store/appStore";
import Transcript from "../Transcript";
import { displayUserPrompt } from "../../lib/attachments";

type Props = {
  task: Task;
  events: TaskEvent[];
  now?: number;
  onClose?: () => void;
  /** Mobile full-screen mode uses larger padding / no close if nested route. */
  fullScreen?: boolean;
};

export default function InspectorPanel({
  task,
  events,
  now = Date.now(),
  onClose,
  fullScreen,
}: Props) {
  const pushToast = useAppStore((s) => s.pushToast);
  const terminal = isTerminal(task.status);

  async function onCancel() {
    try {
      await cancelTask(task.id);
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Cancel failed", "error");
    }
  }

  return (
    <div
      className={[
        "kin-surface-inspector flex flex-col min-h-0 border-l border-[var(--kin-hairline-strong)]",
        fullScreen ? "flex-1" : "w-full max-w-[392px] flex-none",
      ].join(" ")}
    >
      <div className="flex-none px-4 py-3 border-b border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)]">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold text-kin-text truncate">
              {task.title || displayUserPrompt(task.prompt || "")}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-kin-secondary tabular-nums">
              <span>
                <span className="text-kin-muted">status</span>
                {" · "}
                <span className="text-kin-text">{task.status}</span>
              </span>
              <span>
                <span className="text-kin-muted">elapsed</span>
                {" · "}
                <span className="text-kin-text">{formatElapsed(task, now)}</span>
              </span>
              <span>
                <span className="text-kin-muted">cost</span>
                {" · "}
                <span className="text-kin-text">{formatCost(task.cost_usd)}</span>
              </span>
            </div>
            <div className="mt-2 font-mono text-[12px] text-kin-text bg-[var(--kin-fill-strong)] border border-[var(--kin-hairline)] rounded-lg px-2.5 py-2 truncate">
              {task.agent}
              {task.model ? ` · ${task.model}` : ""}
              {task.cwd ? ` · ${task.cwd}` : ""}
            </div>
          </div>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="text-kin-tertiary hover:text-kin-text text-sm px-2 py-1"
            >
              Close
            </button>
          )}
        </div>

        {/* meta bar */}
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          {[
            {
              label: "Tokens",
              value:
                task.tokens_in + task.tokens_out > 0
                  ? `${((task.tokens_in + task.tokens_out) / 1000).toFixed(1)}k`
                  : "—",
            },
            { label: "Cost", value: formatCost(task.cost_usd) },
            { label: "Elapsed", value: formatElapsed(task, now) },
          ].map((m) => (
            <div
              key={m.label}
              className="rounded-lg bg-[var(--kin-fill)] px-2 py-2"
            >
              <div className="text-[11px] text-kin-muted">{m.label}</div>
              <div className="text-[15px] font-semibold tabular-nums mt-0.5">
                {m.value}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto kin-scroll px-4 py-3 min-h-0">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted mb-2">
          transcript
        </div>
        <Transcript events={events} />
      </div>

      {!terminal && (
        <div className="flex-none p-3 border-t border-[var(--kin-hairline)]">
          <button
            type="button"
            onClick={() => void onCancel()}
            className="w-full py-2 rounded-[9px] border border-[rgba(255,69,58,.35)] bg-[rgba(255,69,58,.08)] text-[#ff8a80] text-[13px] font-semibold min-h-[44px]"
          >
            Cancel task
          </button>
        </div>
      )}
    </div>
  );
}
