import { useCallback, useEffect, useMemo, useState } from "react";
import {
  decideApproval,
  formatCost,
  formatElapsed,
  getToken,
  isTerminal,
  listApprovals,
  listTasks,
  parseApprovalPayload,
  type Approval,
  type Task,
} from "../api/client";
import { shortPath } from "../lib/paths";
import { IconFile, IconKin } from "../components/icons";
import { subscribeWS, useAppStore } from "../store/appStore";
import { displayUserPrompt } from "../lib/attachments";

/**
 * Menu-bar tray popover (design 2a) — 360×480 control-center panel.
 * Loaded by Electron as a frameless window; also works as /tray in the browser.
 */
export default function TrayPage() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [busy, setBusy] = useState<Record<string, "approved" | "denied">>({});
  const [now, setNow] = useState(Date.now());
  const wsStatus = useAppStore((s) => s.wsStatus);
  const reconnectGen = useAppStore((s) => s.reconnectGen);

  const load = useCallback(async () => {
    if (!getToken()) return;
    try {
      const [apps, list] = await Promise.all([
        listApprovals("pending"),
        listTasks({ limit: 40 }),
      ]);
      setApprovals(apps);
      setTasks(list);
    } catch {
      // best-effort
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (reconnectGen === 0) return;
    void load();
  }, [reconnectGen, load]);

  useEffect(() => {
    return subscribeWS((msg) => {
      if (msg.kind === "approval_update") {
        const a = msg.data as Approval;
        setApprovals((prev) => {
          if (a.decision !== "pending") return prev.filter((x) => x.id !== a.id);
          const rest = prev.filter((x) => x.id !== a.id);
          return [a, ...rest];
        });
      }
      if (msg.kind === "task_update") {
        const t = msg.data as Task;
        setTasks((prev) => {
          const rest = prev.filter((x) => x.id !== t.id);
          return [t, ...rest].sort((a, b) => b.created_at - a.created_at);
        });
      }
    });
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const running = useMemo(
    () => tasks.filter((t) => !isTerminal(t.status)).slice(0, 5),
    [tasks],
  );

  const doneToday = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const ms = start.getTime();
    return tasks
      .filter((t) => isTerminal(t.status) && t.created_at >= ms)
      .slice(0, 5);
  }, [tasks]);

  async function onDecide(id: string, decision: "approved" | "denied") {
    setBusy((b) => ({ ...b, [id]: decision }));
    try {
      await decideApproval(id, decision);
      setApprovals((prev) => prev.filter((x) => x.id !== id));
    } catch {
      // keep card
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
    }
  }

  function openMain(path: string) {
    // Prefer opener (Electron may set); else top-level navigate.
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.location.href = path;
        window.opener.focus?.();
        return;
      }
    } catch {
      // cross-origin / no opener
    }
    // Custom scheme hook for Electron via hash message
    window.parent?.postMessage?.({ type: "kin-tray-open", path }, "*");
    window.location.href = path;
  }

  const connected = wsStatus === "connected";

  return (
    <div className="h-[100dvh] w-full flex flex-col bg-[rgba(40,40,44,.92)] backdrop-blur-[40px] text-kin-text select-none overflow-hidden">
      {/* Header */}
      <div className="flex items-center px-4 pt-3.5 pb-2.5 flex-none">
        <div className="w-[22px] h-[22px] rounded-md bg-gradient-to-br from-[#5e5ce6] to-[#3a3a8c] flex items-center justify-center mr-2">
          <IconKin size={12} className="text-white" />
        </div>
        <span className="text-[14px] font-semibold">Kin</span>
        <span className="ml-auto text-[11.5px] text-kin-tertiary inline-flex items-center gap-1.5">
          <span
            className={[
              "w-1.5 h-1.5 rounded-full",
              connected ? "bg-kin-green" : "bg-kin-orange animate-pulse",
            ].join(" ")}
          />
          {connected ? "connected" : wsStatus === "connecting" ? "connecting" : "offline"}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto kin-scroll px-3 pb-3 min-h-0">
        {/* Needs you */}
        {approvals.length > 0 && (
          <>
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-kin-orange px-1 pt-2 pb-1.5">
              Needs you · {approvals.length}
            </div>
            <div className="space-y-2">
              {approvals.slice(0, 4).map((a) => {
                const { toolName, input } = parseApprovalPayload(a.payload);
                const path =
                  typeof input.path === "string"
                    ? input.path
                    : typeof input.file_path === "string"
                      ? input.file_path
                      : typeof input.command === "string"
                        ? input.command
                        : "";
                return (
                  <div
                    key={a.id}
                    className="rounded-xl border border-[rgba(255,159,10,.5)] bg-gradient-to-b from-[rgba(255,159,10,.12)] to-[rgba(255,159,10,.03)] p-3"
                  >
                    <div className="flex items-center gap-1.5 text-[12.5px]">
                      <IconFile size={14} className="text-kin-orange flex-none" />
                      <span className="font-semibold">{toolName}</span>
                      <span className="ml-auto text-[10.5px] text-kin-tertiary">
                        {a.task_agent || ""}
                      </span>
                    </div>
                    {path && (
                      <div className="font-mono text-[11px] text-kin-secondary mt-1.5 truncate">
                        {shortPath(path, 40)}
                      </div>
                    )}
                    {a.task_title && (
                      <div className="text-[11px] text-kin-muted mt-1 truncate">
                        {a.task_title}
                      </div>
                    )}
                    <div className="flex gap-1.5 mt-2.5">
                      <button
                        type="button"
                        disabled={!!busy[a.id]}
                        onClick={() => void onDecide(a.id, "approved")}
                        className="flex-1 py-1.5 rounded-lg bg-kin-orange text-[#1a1a1c] text-[12.5px] font-semibold disabled:opacity-50"
                      >
                        {busy[a.id] === "approved" ? "…" : "Approve"}
                      </button>
                      <button
                        type="button"
                        disabled={!!busy[a.id]}
                        onClick={() => void onDecide(a.id, "denied")}
                        className="flex-1 py-1.5 rounded-lg border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] text-[12.5px] font-semibold disabled:opacity-50"
                      >
                        {busy[a.id] === "denied" ? "…" : "Deny"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}

        {/* Running */}
        <div className="text-[10.5px] font-semibold uppercase tracking-wide text-kin-muted px-1 pt-4 pb-1.5">
          Running · {running.length}
        </div>
        {running.length === 0 ? (
          <p className="px-1 text-[12px] text-kin-muted">No active tasks</p>
        ) : (
          <div className="space-y-1.5">
            {running.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => openMain(`/tasks/${t.id}`)}
                className="w-full flex items-center gap-2 rounded-xl border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2.5 text-left"
              >
                <span
                  className={[
                    "w-2 h-2 rounded-full flex-none",
                    t.status === "waiting_approval"
                      ? "bg-kin-orange"
                      : "bg-kin-blue animate-breathe",
                  ].join(" ")}
                />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold truncate">
                    {t.title || displayUserPrompt(t.prompt || "")}
                  </div>
                  <div className="text-[11px] text-kin-tertiary mt-0.5">
                    {t.agent} · {t.status}
                  </div>
                </div>
                <div className="text-right tabular-nums flex-none">
                  <div className="text-[12px] text-kin-secondary">
                    {formatElapsed(t, now)}
                  </div>
                  <div className="text-[11px] text-kin-muted">
                    {formatCost(t.cost_usd)}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Done today */}
        {doneToday.length > 0 && (
          <>
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-kin-muted px-1 pt-4 pb-1.5">
              Done today
            </div>
            <div className="space-y-0.5">
              {doneToday.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => openMain(`/tasks/${t.id}`)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-[10px] text-[12.5px] text-kin-secondary hover:bg-[var(--kin-fill)] text-left"
                >
                  <span className="truncate flex-1">{t.title || displayUserPrompt(t.prompt || "")}</span>
                  <span className="tabular-nums text-kin-muted flex-none">
                    {formatCost(t.cost_usd)}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Footer */}
      <div className="flex-none border-t border-[var(--kin-hairline)] px-3 py-2.5 flex gap-2">
        <button
          type="button"
          onClick={() => openMain("/")}
          className="flex-1 py-2 rounded-lg bg-kin-blue text-white text-[13px] font-semibold"
        >
          Open Kin
        </button>
        <button
          type="button"
          onClick={() => openMain("/new")}
          className="flex-1 py-2 rounded-lg border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] text-[13px] font-semibold"
        >
          New Chat
        </button>
      </div>
    </div>
  );
}
