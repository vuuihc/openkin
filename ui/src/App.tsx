import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { getToken, getRoutineUnreadCount } from "./api/client";
import { liveResources } from "./api/liveResources";
import { SessionSync } from "./api/sessionSync";
import { usePendingResources } from "./api/useLiveResources";
import ConnectScreen from "./components/ConnectScreen";
import NotificationTaps from "./components/NotificationTaps";
import AppShell from "./components/layout/AppShell";
import ToastHost from "./components/ToastHost";
import ApprovalsPage from "./pages/ApprovalsPage";
import ArtifactDetailPage from "./pages/ArtifactDetailPage";
import ArtifactsPage from "./pages/ArtifactsPage";
import DesignSystemPage from "./pages/DesignSystemPage";
import ProjectsPage from "./pages/ProjectsPage";
import ProjectDetailPage from "./pages/ProjectDetailPage";
import NewChatPage from "./pages/NewChatPage";
import SessionsRoute from "./pages/SessionsRoute";
import StartRoute from "./pages/StartRoute";
import SettingsPage from "./pages/SettingsPage";
import TaskSessionHost from "./pages/TaskSessionHost";
import TrayPage from "./pages/TrayPage";
import AgentsPage from "./pages/AgentsPage";
import RoutinesPage from "./pages/RoutinesPage";
import MachineTaskPage from "./pages/MachineTaskPage";
import AgentSessionDetailPage from "./pages/AgentSessionDetailPage";
import ErrorBoundary from "./components/ErrorBoundary";
import AccountScreen from "./components/AccountScreen";
import { applyVisitGate } from "./api/account";
import { dispatchWS, useAppStore, type AuthState } from "./store/appStore";
import { clearSessionViewed } from "./lib/sessionViewed";
import { useMachines } from "./hooks/useMachines";
import { readRoutineDevice, routineDeviceForBadge, THIS_MACHINE } from "./lib/routineDevice";

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
  // Routines belong to machines, so the badge counts the machine the Routines
  // page would open on. Disabled until the console is through the gate: an
  // anonymous read would only 401, and the shell mounts the same hook once the
  // gate is open, so the shared snapshot answers from there.
  const {
    machines,
    loading: machinesLoading,
    failed: machinesFailed,
  } = useMachines({
    enabled: auth.status === "ok",
  });
  // The refresh callback is registered once for websocket events, so it must
  // stay stable; the ref lets it read the list the console has now without
  // making every machine-list update tear down the session sync.
  const machinesRef = useRef({ machines, loading: machinesLoading, failed: machinesFailed });
  machinesRef.current = { machines, loading: machinesLoading, failed: machinesFailed };
  // Only the newest unread answer may land: a machine switch can leave an
  // earlier request in flight.
  const unreadRequest = useRef(0);

  useEffect(() => {
    if (!getToken()) {
      // A Hub session is a cookie, not a token, so "no token" only closes the
      // gate when the daemon has no account system to offer instead.
      const account = useAppStore.getState().account;
      if (account.enabled && !account.authenticated) {
        // The same call main.tsx makes before the first render. It is made
        // twice because this effect also runs on paths that did not come
        // through there, and both answers have to be the same one.
        applyVisitGate();
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
    const { machines, loading, failed } = machinesRef.current;
    // The same rule the Routines page applies before it writes a choice, so
    // the badge cannot name a different machine than the page shows.
    const device = routineDeviceForBadge(machines, readRoutineDevice(), loading, failed);
    // The machine list has not arrived; asking now would count this machine and
    // then count another one a moment later.
    if (device === null) return;
    const seq = ++unreadRequest.current;
    try {
      const { count } = await getRoutineUnreadCount(device === THIS_MACHINE ? undefined : device);
      if (seq !== unreadRequest.current) return;
      setRoutineUnreadCount(count);
    } catch {
      // badge is best-effort
    }
  }, []);

  useEffect(() => {
    if (auth.status !== "ok") return;
    void refreshRoutineUnread();
  }, [
    refreshRoutineUnread,
    auth.status,
    location.pathname,
    machines,
    machinesLoading,
    machinesFailed,
  ]);

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
        {/* A tap that arrives at the sign-in gate still changes the route, so
            the item is there once the reader is through it. */}
        <NotificationTaps />
        <AuthGate auth={auth} />
        <ToastHost />
      </>
    );
  }

  return (
    <>
      <AppShell
        pendingCount={pendingCount}
        pendingApprovals={pending.data.approvals}
        routineUnreadCount={routineUnreadCount}
      >
        <ErrorBoundary>
          {/*
            Session keep-alive lives outside <Routes> so /tasks/:id → /new
            does not unmount the chat DOM (Chrome-tab style scroll retention).
          */}
          <TaskSessionHost />
          <Routes>
            <Route path="/" element={<StartRoute />} />
            <Route path="/new" element={<NewChatPage />} />
            <Route path="/sessions" element={<SessionsRoute />} />
            <Route path="/inbox" element={<ApprovalsPage />} />
            <Route path="/approvals" element={<Navigate to="/inbox" replace />} />
            {/* Task detail UI is rendered by TaskSessionHost above. */}
            <Route path="/tasks/:id" element={null} />
            <Route path="/artifacts" element={<ArtifactsPage />} />
            <Route path="/artifacts/:id" element={<ArtifactDetailPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:id" element={<ProjectDetailPage />} />
            <Route path="/agents" element={<AgentsPage />} />
            <Route path="/routines" element={<RoutinesPage />} />
            {/* A routine run lives on the machine that ran it. The id is not a
                conversation in this Hub's store, so it gets a route that says
                which machine to ask instead of the ordinary session page. */}
            <Route path="/machines/:device/tasks/:id" element={<MachineTaskPage />} />
            <Route path="/usage" element={<Navigate to="/agents" replace />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/agent-sessions/:id" element={<AgentSessionDetailPage />} />
            {/* The token gallery. Not in the nav: it is a place to check the
                design layer, not a place to work. */}
            <Route path="/design" element={<DesignSystemPage />} />
            <Route path="*" element={<Navigate to="/new" replace />} />
          </Routes>
        </ErrorBoundary>
      </AppShell>
      <NotificationTaps />
      <ToastHost />
    </>
  );
}
