import { useCallback, useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import {
  connectWS,
  getToken,
  listApprovals,
  type Approval,
} from "./api/client";
import ApprovalsPage from "./pages/ApprovalsPage";
import SettingsPage from "./pages/SettingsPage";
import TaskDetailPage from "./pages/TaskDetailPage";
import TasksPage from "./pages/TasksPage";
import UsagePage from "./pages/UsagePage";

const navClass = ({ isActive }: { isActive: boolean }) =>
  [
    "px-3 py-2 rounded-lg text-sm font-medium transition-colors relative",
    isActive
      ? "bg-surface-raised text-accent"
      : "text-zinc-400 hover:text-zinc-100 hover:bg-surface-raised/60",
  ].join(" ");

export default function App() {
  const [pendingCount, setPendingCount] = useState(0);

  const refreshCount = useCallback(async () => {
    if (!getToken()) return;
    try {
      const list = await listApprovals("pending");
      setPendingCount(list.length);
    } catch {
      // ignore — badge is best-effort
    }
  }, []);

  useEffect(() => {
    void refreshCount();
  }, [refreshCount]);

  useEffect(() => {
    return connectWS((msg) => {
      if (msg.kind === "approval_update") {
        const a = msg.data as Approval;
        setPendingCount((n) => {
          // Reconcile from WS optimistically; also re-fetch for accuracy.
          if (a.decision === "pending") return n + 1;
          return Math.max(0, n - 1);
        });
        void refreshCount();
      }
    });
  }, [refreshCount]);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-surface-border bg-surface/90 backdrop-blur sticky top-0 z-10">
        <div className="mx-auto max-w-3xl px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold tracking-tight text-zinc-50">Kin</span>
            <span className="hidden sm:inline text-xs text-zinc-500">agent console</span>
          </div>
          <nav className="flex items-center gap-1">
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

      <main className="flex-1 mx-auto w-full max-w-3xl px-4 py-6">
        <Routes>
          <Route path="/" element={<TasksPage />} />
          <Route path="/tasks/:id" element={<TaskDetailPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/usage" element={<UsagePage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
    </div>
  );
}
