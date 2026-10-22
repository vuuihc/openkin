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
import { useMachines } from "../hooks/useMachines";
import {
  cwdAfterMachineChange,
  cwdSuggestions,
  defaultAgentOn,
  findMachine,
  type Machine,
} from "../lib/devices";

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
 * New chat: which machine runs it, then cwd + prompt. Agent is auto-picked from
 * the chosen machine's own inventory (GET /api/agents here, the device's
 * reported list there); an optional override is still allowed.
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
  const {
    machines,
    loading: machinesLoading,
    failed: machinesFailed,
    refresh: refreshMachines,
  } = useMachines();
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [agent, setAgent] = useState<string>(""); // empty = auto
  const [machineId, setMachineId] = useState<string | null>(null); // null = here
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
    // Opening the dialog is when the machine list matters, so it is re-read here
    // rather than trusted from whenever the page happened to load.
    refreshMachines();
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
  }, [open, initialPrompt, refreshMachines]);

  if (!open) return null;

  const selfMachine = machines.find((m) => m.isSelf);
  const selected: Machine | undefined =
    (machineId ? findMachine(machines, machineId) : undefined) ?? selfMachine;
  const isSelf = selected ? selected.isSelf : true;
  const offline = selected ? !selected.online : false;
  const machineName = !selected || selected.isSelf
    ? tr("machine.thisMachine")
    : selected.label;
  const suggestions = cwdSuggestions(selected, dirs);

  const catalog = sortAgentCatalog(runnableAgents(agents));
  const available = runnableAgents(agents);
  const defaultAgent = available.find((a) => a.default) ?? available[0];
  // What can actually start a turn on the chosen machine. For this machine that
  // is the local registry; for another machine it is what that machine
  // reported, which is the list the Hub validates a dispatched agent against.
  const remoteAgents = selected && !selected.isSelf ? selected.agents : [];
  const runnableHere = isSelf ? available : remoteAgents.filter((a) => a.available);
  const defaultAgentId = isSelf ? (defaultAgent?.id ?? "") : (defaultAgentOn(selected)?.id ?? "");
  const agentOptions = isSelf
    ? catalog.map((a) => ({ id: a.id, name: a.name, note: "", generic: agentCatalogState(a) === "generic" }))
    : remoteAgents.map((a) => ({
        id: a.id,
        name: a.id,
        note: a.available ? "" : a.reason || tr("machine.unavailable"),
        generic: false,
      }));
  const bypassing = permissionMode === "accept_edits" || permissionMode === "yolo";

  function chooseMachine(next: Machine) {
    const after = cwdSuggestions(next, dirs);
    setMachineId(next.isSelf ? null : next.id);
    setCwd((c) => cwdAfterMachineChange(c, suggestions, after));
    setAgent((prev) => {
      if (!prev) return prev;
      return next.agents.some((a) => a.id === prev && a.available) ? prev : "";
    });
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (offline) {
      setError(tr("machine.offlineHint", { name: machineName }));
      return;
    }
    if (!cwd.trim() || !prompt.trim()) {
      setError(tr("newChat.required"));
      return;
    }
    if (runnableHere.length === 0) {
      setError(isSelf ? tr("newChat.noAgents") : tr("machine.noAgents", { name: machineName }));
      return;
    }
    const body = {
      cwd: cwd.trim(),
      prompt: prompt.trim(),
      permission_mode: permissionMode,
      ...(agent ? { agent } : {}),
      ...(selected && !selected.isSelf ? { executing_device_id: selected.id } : {}),
    };
    const tempId = `opt_${Date.now()}_${++optSeq}`;
    const optimistic = optimisticTask({
      id: tempId,
      agent: agent || defaultAgentId || "auto",
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
              : tr("newChat.createFailed");
        pushToast(msg, "error");
      }
    })();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
      role="dialog"
      aria-modal="true"
      aria-label={tr("newChat.title")}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        onSubmit={onSubmit}
        className="w-full max-w-lg rounded-2xl border border-[var(--kin-hairline-strong)] bg-kin-elevated shadow-window p-5 space-y-4 max-h-[90dvh] overflow-y-auto"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-kin-text">{tr("newChat.title")}</h2>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] min-w-[44px] text-sm text-kin-tertiary hover:text-kin-text"
          >
            {tr("common.close")}
          </button>
        </div>

        <div className="rounded-xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
              {tr("machine.title")}
            </span>
            <button
              type="button"
              onClick={refreshMachines}
              className="text-[11px] text-kin-blue hover:underline"
            >
              {tr("machine.refresh")}
            </button>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {machinesLoading && machines.length === 0 && (
              <span className="text-[12.5px] text-kin-muted">{tr("newChat.detecting")}</span>
            )}
            {machines.map((m) => {
              const chosen = m.isSelf ? isSelf : selected?.id === m.id;
              return (
                <button
                  key={m.id || "self"}
                  type="button"
                  onClick={() => chooseMachine(m)}
                  aria-pressed={chosen}
                  title={m.roots.length > 0 ? m.roots.join("\n") : m.label}
                  className={[
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium border",
                    chosen
                      ? "border-kin-blue/50 bg-kin-blue-soft text-kin-blue"
                      : "border-[var(--kin-hairline)] text-kin-secondary hover:text-kin-text",
                    m.online ? "" : "opacity-60",
                  ].join(" ")}
                >
                  <span
                    className={[
                      "inline-block h-1.5 w-1.5 rounded-full",
                      m.online ? "bg-kin-green" : "bg-kin-muted",
                    ].join(" ")}
                  />
                  {m.isSelf ? tr("machine.thisMachine") : m.label}
                  {m.online ? "" : ` · ${tr("machine.offline")}`}
                </button>
              );
            })}
          </div>
          {selected && !selected.isSelf ? (
            <p className="mt-2 text-[12px] text-kin-secondary">
              {selected.online
                ? tr("machine.remoteHint", { name: selected.label })
                : tr("machine.offlineHint", { name: selected.label })}
            </p>
          ) : null}
          {!isSelf && bypassing ? (
            <p className="mt-1 text-[12px] text-kin-muted">{tr("machine.bypassHint")}</p>
          ) : null}
          {machinesFailed ? (
            <p className="mt-2 text-[12px] text-kin-muted">{tr("machine.listUnavailable")}</p>
          ) : null}
        </div>

        <div className="rounded-xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2.5">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted">
            {tr("newChat.agentsLabel")}
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {isSelf && catalog.length === 0 && (
              <span className="text-[12.5px] text-kin-muted">{tr("newChat.detecting")}</span>
            )}
            {isSelf &&
              catalog.map((a) => {
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
                    {a.default && isRunnable ? ` · ${tr("machine.defaultMark")}` : ""}
                    {badge ? (
                      <span className="text-[10px] opacity-80">· {badge}</span>
                    ) : null}
                  </span>
                );
              })}
            {!isSelf && remoteAgents.length === 0 && (
              <span className="text-[12.5px] text-kin-muted">
                {tr("machine.noAgents", { name: machineName })}
              </span>
            )}
            {!isSelf &&
              remoteAgents.map((a) => (
                <span
                  key={a.id}
                  className={[
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium border",
                    a.available
                      ? "border-kin-blue/30 bg-kin-blue-soft text-kin-blue"
                      : "border-[var(--kin-hairline)] text-kin-muted",
                  ].join(" ")}
                  title={a.reason || a.id}
                >
                  <span
                    className={[
                      "inline-block h-1.5 w-1.5 rounded-full",
                      a.available ? "bg-kin-green" : "bg-kin-muted",
                    ].join(" ")}
                  />
                  {a.id}
                  {a.isDefault && a.available ? ` · ${tr("machine.defaultMark")}` : ""}
                  {a.available || !a.reason ? "" : ` · ${a.reason}`}
                </span>
              ))}
          </div>
          {agents.some((a) => !a.available) && isSelf ? (
            <div className="mt-2">
              <Link to="/agents" className="text-[12px] text-kin-blue hover:underline" onClick={onClose}>
                {tr("agents.manageLink")}
              </Link>
            </div>
          ) : null}
          <p className="mt-2 text-[12px] text-kin-secondary">
            {isSelf
              ? tr("newChat.agentHint", { name: defaultAgent?.name ?? "—" })
              : tr("newChat.agentHintRemote", { name: machineName })}
          </p>
          <button
            type="button"
            className="mt-1 text-[12px] text-kin-blue hover:underline"
            onClick={() => setShowAgent((v) => !v)}
          >
            {showAgent ? tr("newChat.hideOverride") : tr("newChat.override")}
          </button>
          {showAgent && (
            <select
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              className="kin-input min-h-[40px] mt-2"
            >
              <option value="">{tr("newChat.autoAgent", { id: defaultAgentId || "—" })}</option>
              {agentOptions.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.id})
                  {a.generic ? ` — ${tr("agentCatalog.generic")}` : ""}
                  {a.note ? ` — ${a.note}` : ""}
                </option>
              ))}
            </select>
          )}
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-kin-secondary">
            {isSelf ? tr("newChat.cwdLabel") : tr("newChat.cwdOnMachine", { name: machineName })}
          </span>
          <input
            list="recent-cwds"
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="/path/to/repo"
            className="kin-input min-h-[44px]"
            autoComplete="off"
          />
          <datalist id="recent-cwds">
            {suggestions.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
          {!isSelf && suggestions.length === 0 ? (
            <span className="block text-[11px] text-kin-muted">
              {tr("machine.noRoots", { name: machineName })}
            </span>
          ) : null}
        </label>

        <div className="block space-y-1.5">
          <span className="text-xs font-medium text-kin-secondary">{tr("newChat.permissionLabel")}</span>
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
          <span className="text-xs font-medium text-kin-secondary">{tr("newChat.promptLabel")}</span>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            placeholder={tr("newChat.promptPlaceholder")}
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
            {tr("common.cancel")}
          </button>
          <button
            type="submit"
            disabled={submitting || offline}
            className="kin-btn-primary disabled:opacity-50"
          >
            {tr("newChat.dispatch")}
          </button>
        </div>
      </form>
    </div>
  );
}
