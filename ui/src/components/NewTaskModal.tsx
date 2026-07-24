import { FormEvent, useEffect, useState } from "react";
import {
  ApiError,
  createTask,
  listAgents,
  optimisticTask,
  recentCwds,
  type AgentInfo,
  type Task,
} from "../api/client";
import { useAppStore } from "../store/appStore";
import { useT } from "../i18n/react";
import { Link } from "react-router-dom";
import {
  agentCatalogState,
  runnableAgents,
  sortAgentCatalog,
} from "../lib/agentCatalog";
import {
  getDraftPermissionMode,
  setDraftPermissionMode,
  type PermissionMode,
} from "../lib/permissionMode";
import PermissionModePicker from "./chat/PermissionModePicker";

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated: (task: Task) => void;
  onOptimistic?: (task: Task) => void;
  onOptimisticFail?: (tempId: string) => void;
  initialPrompt?: string;
};

let optSeq = 0;

/**
 * New chat: cwd + prompt only. Agent is auto-picked from installed CLIs
 * (GET /api/agents). Optional override still allowed via advanced select.
 */
export default function NewTaskModal({
  open,
  onClose,
  onCreated,
  onOptimistic,
  onOptimisticFail,
  initialPrompt,
}: Props) {
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agent, setAgent] = useState<string>(""); // empty = auto
  const [cwd, setCwd] = useState("");
  const [prompt, setPrompt] = useState("");
  const [dirs, setDirs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showAgent, setShowAgent] = useState(false);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(() => getDraftPermissionMode());

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (initialPrompt) setPrompt(initialPrompt);
    recentCwds()
      .then((d) => {
        setDirs(d);
        setCwd((c) => c || d[0] || "");
      })
      .catch(() => setDirs([]));
    listAgents()
      .then((list) => {
        setAgents(list);
        // Keep agent empty (auto) unless previously chosen unavailable.
        setAgent((prev) => {
          if (!prev) return "";
          return list.some((a) => a.id === prev && a.available) ? prev : "";
        });
      })
      .catch(() => setAgents([]));
  }, [open, initialPrompt]);

  if (!open) return null;

  const catalog = sortAgentCatalog(runnableAgents(agents));
  const available = runnableAgents(agents);
  const defaultAgent = available.find((a) => a.default) ?? available[0];

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!cwd.trim() || !prompt.trim()) {
      setError("cwd and prompt are required");
      return;
    }
    if (available.length === 0) {
      setError("No agents installed — install claude, codex, or grok CLI");
      return;
    }
    const body = {
      cwd: cwd.trim(),
      prompt: prompt.trim(),
      permission_mode: permissionMode,
      ...(agent ? { agent } : {}),
    };
    const tempId = `opt_${Date.now()}_${++optSeq}`;
    const optimistic = optimisticTask({
      id: tempId,
      agent: agent || defaultAgent?.id || "auto",
      cwd: body.cwd,
      prompt: body.prompt,
    });

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      role="dialog"
      aria-modal="true"
      aria-label="New chat"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-lg rounded-2xl border border-[var(--kin-hairline-strong)] bg-kin-elevated shadow-window p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-kin-text">New chat</h2>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] text-sm text-kin-tertiary hover:text-kin-text"
          >
            Close
          </button>
        </div>

        <div className="rounded-xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
            Agents
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {catalog.length === 0 && (
              <span className="text-[12.5px] text-kin-muted">Detecting…</span>
            )}
            {catalog.map((a) => {
              const state = agentCatalogState(a);
              const isRunnable = state === "native" || state === "generic";
              const badge = state === "generic" ? tr("agentCatalog.generic") : null;
              const title =
                state === "generic" ? tr("agentCatalog.genericHint") : a.binary || a.name;
              return (
                <span
                  key={a.id}
                  className={[
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium border",
                    isRunnable
                      ? "border-kin-blue/30 bg-kin-blue-soft text-kin-blue"
                      : "border-[var(--kin-hairline)] text-kin-muted",
                  ].join(" ")}
                  title={title}
                >
                  <span
                    className={[
                      "inline-block h-1.5 w-1.5 rounded-full",
                      isRunnable ? "bg-kin-green" : "bg-kin-muted",
                    ].join(" ")}
                  />
                  {a.name}
                  {a.default && isRunnable ? " · default" : ""}
                  {badge ? (
                    <span className="text-[10px] opacity-80">· {badge}</span>
                  ) : null}
                </span>
              );
            })}
          </div>
          {agents.some((a) => !a.available) ? (
            <div className="mt-2">
              <Link to="/agents" className="text-[12px] text-kin-blue hover:underline" onClick={onClose}>
                {tr("agents.manageLink")}
              </Link>
            </div>
          ) : null}
          <p className="mt-2 text-[12px] text-kin-secondary">

            新建任务不强制选 agent — 默认用{" "}
            <b className="text-kin-text font-semibold">
              {defaultAgent?.name ?? "—"}
            </b>
            。同一 task 里可以随时 handoff 到别的 agent。
          </p>
          <button
            type="button"
            className="mt-1 text-[12px] text-kin-blue hover:underline"
            onClick={() => setShowAgent((v) => !v)}
          >
            {showAgent ? "Hide override" : "Override default agent…"}
          </button>
          {showAgent && (
            <select
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              className="kin-input min-h-[40px] mt-2"
            >
              <option value="">Auto ({defaultAgent?.id ?? "none"})</option>
              {catalog.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.id})
                  {agentCatalogState(a) === "generic"
                    ? ` — ${tr("agentCatalog.generic")}`
                    : ""}
                </option>
              ))}
            </select>
          )}
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-kin-secondary">Working directory (cwd)</span>
          <input
            list="recent-cwds"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/path/to/repo"
            className="kin-input min-h-[44px]"
            autoComplete="off"
          />
          <datalist id="recent-cwds">
            {dirs.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </label>

        <div className="block space-y-1.5">
          <span className="text-xs font-medium text-kin-secondary">Permission mode</span>
          <PermissionModePicker
            value={permissionMode}
            onChange={(m) => {
              setPermissionMode(m);
              setDraftPermissionMode(m);
            }}
          />
          {agent && agents.find((a) => a.id === agent && agentCatalogState(a) === "generic") ? (
            <p className="text-[11px] text-kin-muted">{tr("agentCatalog.genericHint")}</p>
          ) : null}
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-kin-secondary">Prompt</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            placeholder="What should Kin do?"
            className="kin-input resize-y"
          />
        </label>

        {error && (
          <p className="text-sm text-kin-red" role="alert">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="kin-btn-secondary"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="kin-btn-primary disabled:opacity-50"
          >
            Dispatch
          </button>
        </div>
      </form>
    </div>
  );
}
