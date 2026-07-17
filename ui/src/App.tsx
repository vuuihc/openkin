import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import {
  connectWS,
  getToken,
  listApprovals,
  type Approval,
} from "./api/client";
import ConnectScreen from "./components/ConnectScreen";
import AppShell from "./components/layout/AppShell";
import ToastHost from "./components/ToastHost";
import ApprovalsPage from "./pages/ApprovalsPage";
import NewChatPage from "./pages/NewChatPage";
import SettingsPage from "./pages/SettingsPage";
import TaskDetailPage from "./pages/TaskDetailPage";
import TasksPage from "./pages/TasksPage";
import TrayPage from "./pages/TrayPage";
import UsagePage from "./pages/UsagePage";
import { dispatchWS, useAppStore } from "./store/appStore";

export default function App() {
  const auth = useAppStore((s) => s.auth);
  const requireToken = useAppStore((s) => s.requireToken);
  const setAuthOk = useAppStore((s) => s.setAuthOk);
  const [pendingCount, setPendingCount] = useState(0);
  const location = useLocation();
  const isTray = location.pathname === "/tray";

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
      // badge is best-effort
    }
  }, []);

  useEffect(() => {
    if (auth.status !== "ok") return;
    void refreshCount();
  }, [refreshCount, auth.status]);

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

  // Tray popover is a minimal chrome-less surface (still needs token).
  if (isTray) {
    if (auth.status === "need_token") {
      return (
        <>
          <ConnectScreen reason={auth.reason} />
          <ToastHost />
        </>
      );
    }
    return (
      <>
        <TrayPage />
        <ToastHost />
      </>
    );
  }

  if (auth.status === "need_token") {
    return (
      <>
        <ConnectScreen reason={auth.reason} />
        <ToastHost />
      </>
    );
  }

  return (
    <>
      <AppShell pendingCount={pendingCount}>
        <Routes>
          <Route path="/" element={<Navigate to="/new" replace />} />
          <Route path="/new" element={<NewChatPage />} />
          <Route path="/inbox" element={<ApprovalsPage />} />
          <Route path="/approvals" element={<Navigate to="/inbox" replace />} />
          <Route path="/tasks" element={<TasksPage />} />
          <Route path="/tasks/:id" element={<TaskDetailPage />} />
          <Route path="/usage" element={<UsagePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/new" replace />} />
        </Routes>
      </AppShell>
      <ToastHost />
    </>
  );
}
