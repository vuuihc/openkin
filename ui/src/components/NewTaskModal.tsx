import { FormEvent, useEffect, useState } from "react";
import {
  ApiError,
  createTask,
  optimisticTask,
  recentCwds,
  type Task,
} from "../api/client";
import { useAppStore } from "../store/appStore";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (task: Task) => void;
  /** Called immediately with a local queued row before the network returns. */
  onOptimistic?: (task: Task) => void;
  onOptimisticFail?: (tempId: string) => void;
};

const AGENTS = [
  { value: "claude-code", label: "claude-code" },
  { value: "codex", label: "codex" },
  { value: "rawpty", label: "Command (raw)" },
] as const;

let optSeq = 0;

export default function NewTaskModal({
  open,
  onClose,
  onCreated,
  onOptimistic,
  onOptimisticFail,
}: Props) {
  const pushToast = useAppStore((s) => s.pushToast);
  const [agent, setAgent] = useState<string>("claude-code");
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [dirs, setDirs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    recentCwds()
      .then(setDirs)
      .catch(() => setDirs([]));
  }, [open]);

  if (!open) return null;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!cwd.trim() || !prompt.trim()) {
      setError("cwd and prompt are required");
      return;
    }
    const body = {
      agent,
      cwd: cwd.trim(),
      prompt: prompt.trim(),
    };
    const tempId = `opt_${Date.now()}_${++optSeq}`;
    const optimistic = optimisticTask({ id: tempId, ...body });

    // Optimistic: close modal immediately, show queued row.
    setPrompt("");
    onOptimistic?.(optimistic);
    onClose();
    setSubmitting(false);

    void (async () => {
      try {
        const task = await createTask(body);
        onCreated(task);
      } catch (err) {
        onOptimisticFail?.(tempId);
        const msg =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Failed to create task";
        pushToast(msg, "error");
      }
    })();
  }

  const promptPlaceholder =
    agent === "rawpty"
      ? "Shell command, e.g. printf 'hello\\n'  (runs via /bin/sh -c)"
      : "What should the agent do?";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      role="dialog"
      aria-modal="true"
      aria-label="New task"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-lg rounded-2xl border border-surface-border bg-surface-raised shadow-xl p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-zinc-50">New task</h2>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] text-sm text-zinc-400 hover:text-zinc-100"
          >
            Close
          </button>
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-zinc-400">Agent</span>
          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            className="w-full min-h-[44px] rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-zinc-100"
          >
            {AGENTS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-zinc-400">Working directory (cwd)</span>
          <input
            list="recent-cwds"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/path/to/repo"
            className="w-full min-h-[44px] rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
            autoComplete="off"
          />
          <datalist id="recent-cwds">
            {dirs.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-zinc-400">
            {agent === "rawpty" ? "Command" : "Prompt"}
          </span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            placeholder={promptPlaceholder}
            className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 resize-y"
          />
        </label>

        {error && (
          <p className="text-sm text-red-300" role="alert">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] rounded-lg px-4 py-2 text-sm text-zinc-300 hover:bg-surface"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="min-h-[44px] rounded-lg bg-accent px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-accent-muted disabled:opacity-50"
          >
            Dispatch
          </button>
        </div>
      </form>
    </div>
  );
}
