import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import {
  getToken,
  getRoutineUnreadCount,
} from "./api/client";
import { liveResources } from "./api/liveResources";
import { SessionSync } from "./api/sessionSync";
import { usePendingResources } from "./api/useLiveResources";
import ConnectScreen from "./components/ConnectScreen";
import AppShell from "./components/layout/AppShell";
import ToastHost from "./components/ToastHost";
import ApprovalsPage from "./pages/ApprovalsPage";
import ArtifactDetailPage from "./pages/ArtifactDetailPage";
import ArtifactsPage from "./pages/ArtifactsPage";
import ProjectsPage from "./pages/ProjectsPage";
import ProjectDetailPage from "./pages/ProjectDetailPage";
import NewChatPage from "./pages/NewChatPage";
import SettingsPage from "./pages/SettingsPage";
import TaskSessionHost from "./pages/TaskSessionHost";
import TasksPage from "./pages/TasksPage";
import TrayPage from "./pages/TrayPage";
import AgentsPage from "./pages/AgentsPage";
import RoutinesPage from "./pages/RoutinesPage";
import AgentSessionDetailPage from "./pages/AgentSessionDetailPage";
import ErrorBoundary from "./components/ErrorBoundary";
import AccountScreen from "./components/AccountScreen";
import { gateFor } from "./lib/accountGate";
import { dispatchWS, useAppStore, type AuthState } from "./store/appStore";
import { clearSessionViewed } from "./lib/sessionViewed";

/** The one thing standing between an anonymous browser and the console. */
function AuthGate({ auth }: { auth: Exclude<AuthState, { status: "ok" }> }) {
  if (auth.status === "need_account") {
    return <AccountScreen mode={auth.mode} />;
  }
  return <ConnectScreen reason={auth.reason} />;
}

export default function App() {
  const auth = useAppStore((s) => s.auth);
  const requireToken = useAppStore((s) => s.requireToken);
  const setAuthOk = useAppStore((s) => s.setAuthOk);
  const [routineUnreadCount, setRoutineUnreadCount] = useState(0);
  const pending = usePendingResources(auth.status === "ok");
  const pendingCount = pending.data.approvals.length;
  const location = useLocation();
  const isTray = location.pathname === "/tray";

  useEffect(() => {
    if (!getToken()) {
      // A Hub session is a cookie, not a token, so "no token" only closes the
      // gate when the daemon has no account system to offer instead.
      const account = useAppStore.getState().account;
      if (account.enabled && !account.authenticated) {
        const gate = gateFor(account);
        useAppStore.getState().requireAccount(gate === "claim" ? "claim" : "login");
        return;
      }
      if (!account.enabled) {
        requireToken("missing");
        return;
      }
    }
    setAuthOk();
  }, [requireToken, setAuthOk]);

  const refreshRoutineUnread = useCallback(async () => {
    // Deliberately not gated on getToken(): a Hub session authenticates with a
    // cookie and has no local token, and the badge works there too.
    if (useAppStore.getState().auth.status !== "ok") return;
    try {
      const { count } = await getRoutineUnreadCount();
      setRoutineUnreadCount(count);
    } catch {
      // badge is best-effort
    }
  }, []);

  useEffect(() => {
    if (auth.status !== "ok") return;
    void refreshRoutineUnread();
  }, [refreshRoutineUnread, auth.status, location.pathname]);

  useEffect(() => {
    if (auth.status !== "ok") return;
    const onUnread = () => {
      void refreshRoutineUnread();
    };
    window.addEventListener("kin:routine-unread-changed", onUnread);
    return () => window.removeEventListener("kin:routine-unread-changed", onUnread);
  }, [refreshRoutineUnread, auth.status]);

  useEffect(() => {
    if (auth.status !== "ok") return;
    const sync = new SessionSync(liveResources, {
      onMessage: (msg) => {
        dispatchWS(msg);
        if (msg.kind === "task_update") {
          if (msg.data.status === "running" || msg.data.status === "queued") {
            clearSessionViewed(msg.data.id);
          }
          if (msg.data.routine_id) void refreshRoutineUnread();
        }
      },
    });
    sync.start();
    return () => sync.stop();
  }, [refreshRoutineUnread, auth.status]);

  // Tray popover is a minimal chrome-less surface (still needs auth).
  if (isTray) {
    if (auth.status !== "ok") {
      return (
        <>
          <AuthGate auth={auth} />
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

  if (auth.status !== "ok") {
    return (
      <>
        <AuthGate auth={auth} />
        <ToastHost />
      </>
    );
  }

  return (
    <>
      <AppShell pendingCount={pendingCount} routineUnreadCount={routineUnreadCount}>
        <ErrorBoundary>
          {/*
            Session keep-alive lives outside <Routes> so /tasks/:id → /new
            does not unmount the chat DOM (Chrome-tab style scroll retention).
          */}
          <TaskSessionHost />
          <Routes>
            <Route path="/" element={<Navigate to="/new" replace />} />
            <Route path="/new" element={<NewChatPage />} />
            <Route path="/inbox" element={<ApprovalsPage />} />
            <Route path="/approvals" element={<Navigate to="/inbox" replace />} />
            <Route path="/tasks" element={<TasksPage />} />
            {/* Task detail UI is rendered by TaskSessionHost above. */}
            <Route path="/tasks/:id" element={null} />
            <Route path="/artifacts" element={<ArtifactsPage />} />
            <Route path="/artifacts/:id" element={<ArtifactDetailPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:id" element={<ProjectDetailPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/routines" element={<RoutinesPage />} />
            <Route path="/usage" element={<Navigate to="/agents" replace />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/agent-sessions/:id" element={<AgentSessionDetailPage />} />
            <Route path="*" element={<Navigate to="/new" replace />} />
          </Routes>
        </ErrorBoundary>
      </AppShell>
      <ToastHost />
    </>
  );
}
