import { useEffect, useMemo, useState } from "react";
import {
  decideApproval,
  formatCost,
  formatElapsed,
  isTerminal,
  parseApprovalPayload,
} from "../api/client";
import { liveResources } from "../api/liveResources";
import { usePendingResources, useTaskList } from "../api/useLiveResources";
import { shortPath } from "../lib/paths";
import { IconFile, IconKin } from "../components/icons";
import { useAppStore } from "../store/appStore";
import { displayUserPrompt } from "../lib/attachments";

/**
 * Menu-bar tray popover (design 2a) — 360×480 control-center panel.
 * Loaded by Electron as a frameless window; also works as /tray in the browser.
 */
export default function TrayPage() {
  const pending = usePendingResources();
  const taskList = useTaskList({ limit: 40 });
  const approvals = pending.data.approvals;
  const tasks = taskList.data;
  const [busy, setBusy] = useState<Record<string, "approved" | "denied">>({});
  const [now, setNow] = useState(Date.now());
  const wsStatus = useAppStore((s) => s.wsStatus);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const running = useMemo(() => tasks.filter((t) => !isTerminal(t.status)).slice(0, 5), [tasks]);

  const doneToday = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const ms = start.getTime();
    return tasks.filter((t) => isTerminal(t.status) && t.created_at >= ms).slice(0, 5);
  }, [tasks]);

  async function onDecide(id: string, decision: "approved" | "denied") {
    setBusy((b) => ({ ...b, [id]: decision }));
    try {
      const updated = await decideApproval(id, decision);
      liveResources.applyMessage({ kind: "approval_update", data: updated });
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
    <div className="h-[100dvh] w-full flex flex-col bg-kin-panel/90 backdrop-blur-[40px] text-kin-text select-none overflow-hidden">
      {/* Header */}
      <div className="flex items-center px-4 pt-3.5 pb-2.5 flex-none">
        <div className="w-[22px] h-[22px] rounded-md bg-kin-blue flex items-center justify-center mr-2">
          <IconKin size={12} className="text-kin-on-brand" />
        </div>
        <span className="text-strong font-semibold">Kin</span>
        <span className="ml-auto text-caption text-kin-muted inline-flex items-center gap-1.5">
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
            <div className="text-caption font-semibold uppercase tracking-label text-kin-orange-ink px-1 pt-2 pb-1.5">
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
                    className="rounded-xl border border-kin-orange/50 bg-gradient-to-b from-kin-orange/10 to-kin-orange/5 p-3"
                  >
                    <div className="flex items-center gap-1.5 text-body">
                      <IconFile size={14} className="text-kin-orange-ink flex-none" />
                      <span className="font-semibold">{toolName}</span>
                      <span className="ml-auto text-caption text-kin-muted">
                        {a.task_agent || ""}
                      </span>
                    </div>
                    {path && (
                      <div className="font-mono text-caption text-kin-secondary mt-1.5 truncate">
                        {shortPath(path, 40)}
                      </div>
                    )}
                    {a.task_title && (
                      <div className="text-caption text-kin-muted mt-1 truncate">
                        {a.task_title}
                      </div>
                    )}
                    <div className="flex gap-1.5 mt-2.5">
                      <button
                        type="button"
                        disabled={!!busy[a.id]}
                        onClick={() => void onDecide(a.id, "approved")}
                        className="flex-1 py-1.5 rounded-lg bg-kin-orange text-kin-on-status text-body font-semibold disabled:opacity-50"
                      >
                        {busy[a.id] === "approved" ? "…" : "Approve"}
                      </button>
                      <button
                        type="button"
                        disabled={!!busy[a.id]}
                        onClick={() => void onDecide(a.id, "denied")}
                        className="flex-1 py-1.5 rounded-lg border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] text-body font-semibold disabled:opacity-50"
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
        <div className="text-caption font-semibold uppercase tracking-label text-kin-muted px-1 pt-4 pb-1.5">
          Running · {running.length}
        </div>
        {running.length === 0 ? (
          <p className="px-1 text-body text-kin-muted">No active tasks</p>
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
                  <div className="text-strong font-semibold truncate">
                    {t.title || displayUserPrompt(t.prompt || "")}
                  </div>
                  <div className="text-caption text-kin-muted mt-0.5">
                    {t.agent} · {t.status}
                  </div>
                </div>
                <div className="text-right tabular-nums flex-none">
                  <div className="text-body text-kin-secondary">{formatElapsed(t, now)}</div>
                  <div className="text-caption text-kin-muted">{formatCost(t.cost_usd)}</div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Done today */}
        {doneToday.length > 0 && (
          <>
            <div className="text-caption font-semibold uppercase tracking-label text-kin-muted px-1 pt-4 pb-1.5">
              Done today
            </div>
            <div className="space-y-0.5">
              {doneToday.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => openMain(`/tasks/${t.id}`)}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-body text-kin-secondary hover:bg-[var(--kin-fill)] text-left"
                >
                  <span className="truncate flex-1">
                    {t.title || displayUserPrompt(t.prompt || "")}
                  </span>
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
          className="flex-1 py-2 rounded-lg bg-kin-blue text-kin-on-brand text-strong font-semibold"
        >
          Open Kin
        </button>
        <button
          type="button"
          onClick={() => openMain("/new")}
          className="flex-1 py-2 rounded-lg border border-[var(--kin-hairline-strong)] bg-[var(--kin-fill)] text-strong font-semibold"
        >
          New Chat
        </button>
      </div>
    </div>
  );
}
