import { FormEvent, useEffect, useState } from "react";
import { ApiError, createTask, recentCwds, type Task } from "../api/client";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (task: Task) => void;
};

const AGENTS = [
  { value: "claude-code", label: "claude-code" },
  { value: "codex", label: "codex" },
  { value: "rawpty", label: "Command (raw)" },
] as const;

export default function NewTaskModal({ open, onClose, onCreated }: Props) {
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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!cwd.trim() || !prompt.trim()) {
      setError("cwd and prompt are required");
      return;
    }
    setSubmitting(true);
    try {
      const task = await createTask({
        agent,
        cwd: cwd.trim(),
        prompt: prompt.trim(),
      });
      setPrompt("");
      onCreated(task);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : "Failed to create task");
      }
    } finally {
      setSubmitting(false);
    }
  }

  const promptPlaceholder =
    agent === "rawpty"
      ? "Shell command, e.g. printf 'hello\\n'  (runs via /bin/sh -c)"
      : "What should the agent do?";

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="New task"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-lg rounded-2xl border border-surface-border bg-surface-raised shadow-xl p-5 space-y-4"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-zinc-50">New task</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-zinc-400 hover:text-zinc-100"
          >
            Close
          </button>
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-zinc-400">Agent</span>
          <select
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
            className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-zinc-100"
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
            className="w-full rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600"
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
            className="rounded-lg px-3 py-2 text-sm text-zinc-300 hover:bg-surface"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-zinc-900 hover:bg-accent-muted disabled:opacity-50"
          >
            {submitting ? "Dispatching…" : "Dispatch"}
          </button>
        </div>
      </form>
    </div>
  );
}
