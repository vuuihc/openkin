import { useCallback, useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import {
  connectWS,
  getToken,
  listApprovals,
  type Approval,
} from "./api/client";
import ConnectScreen from "./components/ConnectScreen";
import ToastHost from "./components/ToastHost";
import ApprovalsPage from "./pages/ApprovalsPage";
import SettingsPage from "./pages/SettingsPage";
import TaskDetailPage from "./pages/TaskDetailPage";
import TasksPage from "./pages/TasksPage";
import UsagePage from "./pages/UsagePage";
import { dispatchWS, useAppStore } from "./store/appStore";

const navClass = ({ isActive }: { isActive: boolean }) =>
  [
    "min-h-[44px] min-w-[44px] inline-flex items-center justify-center px-3 py-2 rounded-lg text-sm font-medium transition-colors relative",
    isActive
      ? "bg-surface-raised text-accent"
      : "text-zinc-400 hover:text-zinc-100 hover:bg-surface-raised/60",
  ].join(" ");

function ConnectionDot({ status }: { status: string }) {
  const color =
    status === "connected"
      ? "bg-emerald-400"
      : status === "connecting"
        ? "bg-amber-400 animate-pulse"
        : "bg-zinc-500";
  const label =
    status === "connected"
      ? "Live"
      : status === "connecting"
        ? "Connecting"
        : "Offline";
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-zinc-500"
      title={`WebSocket: ${label}`}
      aria-label={`Connection ${label}`}
    >
      <span className={`h-2 w-2 rounded-full ${color}`} />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}

export default function App() {
  const auth = useAppStore((s) => s.auth);
  const requireToken = useAppStore((s) => s.requireToken);
  const setAuthOk = useAppStore((s) => s.setAuthOk);
  const wsStatus = useAppStore((s) => s.wsStatus);
  const [pendingCount, setPendingCount] = useState(0);

  // Boot: missing token → connect screen immediately (shell still instant).
  useEffect(() => {
    if (!getToken()) {
      requireToken("missing");
    } else {
      setAuthOk();
    }
  }, [requireToken, setAuthOk]);

  const refreshCount = useCallback(async () => {
    if (!getToken()) return;
    if (useAppStore.getState().auth.status === "need_token") return;
    try {
      const list = await listApprovals("pending");
      setPendingCount(list.length);
    } catch {
      // ignore — badge is best-effort; 401 handled globally
    }
  }, []);

  useEffect(() => {
    if (auth.status !== "ok") return;
    void refreshCount();
  }, [refreshCount, auth.status]);

  // Single app-wide WS: status + fan-out to page subscribers + approval badge.
  useEffect(() => {
    if (auth.status !== "ok") return;
    return connectWS({
      onMessage: (msg) => {
        dispatchWS(msg);
        if (msg.kind === "approval_update") {
          const a = msg.data as Approval;
          setPendingCount((n) => {
            if (a.decision === "pending") return n + 1;
            return Math.max(0, n - 1);
          });
          void refreshCount();
        }
      },
      onOpen: () => {
        void refreshCount();
      },
    });
  }, [refreshCount, auth.status]);

  // Auth recovery: full-screen connect, no raw dead-end.
  if (auth.status === "need_token") {
    return (
      <>
        <ConnectScreen reason={auth.reason} />
        <ToastHost />
      </>
    );
  }

  return (
    <div className="min-h-[100dvh] flex flex-col safe-pad">
      {wsStatus !== "connected" && (
        <div
          className="bg-amber-950/80 border-b border-amber-900/50 text-amber-100 text-xs text-center px-3 py-1.5"
          role="status"
        >
          {wsStatus === "connecting" ? "reconnecting…" : "disconnected — reconnecting…"}
        </div>
      )}

      <header className="border-b border-surface-border bg-surface/90 backdrop-blur sticky top-0 z-10 pt-[env(safe-area-inset-top)]">
        <div className="mx-auto max-w-3xl px-4 py-2 flex items-center justify-between gap-3 overflow-x-auto">
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-lg font-semibold tracking-tight text-zinc-50">Kin</span>
            <span className="hidden sm:inline text-xs text-zinc-500">agent console</span>
            <ConnectionDot status={wsStatus} />
          </div>
          <nav className="flex items-center gap-0.5 shrink-0">
            <NavLink to="/" end className={navClass}>
              Tasks
            </NavLink>
            <NavLink to="/approvals" className={navClass}>
              Approvals
              {pendingCount > 0 && (
                <span className="ml-1.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-black">
                  {pendingCount > 99 ? "99+" : pendingCount}
                </span>
              )}
            </NavLink>
            <NavLink to="/usage" className={navClass}>
              Usage
            </NavLink>
            <NavLink to="/settings" className={navClass}>
              Settings
            </NavLink>
          </nav>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-3xl px-4 py-6 overflow-x-hidden">
        <Routes>
          <Route path="/" element={<TasksPage />} />
          <Route path="/tasks/:id" element={<TaskDetailPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/usage" element={<UsagePage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>

      <ToastHost />
    </div>
  );
}
