import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { getToken, getRoutineUnreadCount } from "./api/client";
import { liveResources } from "./api/liveResources";
import { SessionSync } from "./api/sessionSync";
import { usePendingResources } from "./api/useLiveResources";
import ConnectScreen from "./components/ConnectScreen";
import NotificationTaps from "./components/NotificationTaps";
import AppShell from "./components/layout/AppShell";
import AreaRoute from "./components/layout/AreaRoute";
import ToastHost from "./components/ToastHost";
import ProjectDetailPage from "./pages/ProjectDetailPage";
import ProjectsCollectionPage from "./pages/ProjectsCollectionPage";
import { designSystemRoute } from "./pages/DesignSystemPage";
import NewChatPage from "./pages/NewChatPage";
import SessionsRoute from "./pages/SessionsRoute";
import StartRoute from "./pages/StartRoute";
import SettingsPage from "./pages/SettingsPage";
import TaskSessionHost from "./pages/TaskSessionHost";
import TrayPage from "./pages/TrayPage";
import RoutinesPage from "./pages/RoutinesPage";
import MachineTaskPage from "./pages/MachineTaskPage";
import AgentSessionDetailPage from "./pages/AgentSessionDetailPage";
import ErrorBoundary from "./components/ErrorBoundary";
import AccountScreen from "./components/AccountScreen";
import { applyVisitGate, isAccountProbeUnanswered } from "./api/account";
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
        // StrictMode's first pass already retired the unanswered placeholder,
        // so `enabled: false` here may still mean "no answer yet", not "this
        // daemon has no accounts". The deadline path already opened the gate;
        // closing it now would show the token screen it avoided.
        if (!isAccountProbeUnanswered()) requireToken("missing");
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
      <AppShell pendingApprovals={pending.data.approvals} routineUnreadCount={routineUnreadCount}>
        <ErrorBoundary>
          {/*
            Session keep-alive lives outside <Routes> so /tasks/:id → /new
            does not unmount the chat DOM (Chrome-tab style scroll retention).
          */}
          <TaskSessionHost />
          {/* Only the route page animates. The host above stays mounted, so a
              push/pop moves the arriving page and never the live chat. */}
          <AreaRoute>
            <Routes>
              <Route path="/" element={<StartRoute />} />
              <Route path="/new" element={<NewChatPage />} />
              <Route path="/sessions" element={<SessionsRoute />} />
              {/* Banners and bookmarks delivered before R0b-2a still name the
                  inbox. The list is its replacement, and every row there says
                  what is waiting. */}
              <Route path="/inbox" element={<Navigate to="/sessions" replace />} />
              <Route path="/approvals" element={<Navigate to="/sessions" replace />} />
              {/* Task detail UI is rendered by TaskSessionHost above. */}
              <Route path="/tasks/:id" element={null} />
              {/* The Projects area root. Agent operations live in Settings →
                  Operations, so the old full-page destinations redirect there:
                  a bookmark, banner or notification from before E4a still lands
                  on the panel. `App.areaRoutes.test.ts` pins the target. */}
              <Route path="/projects" element={<ProjectsCollectionPage />} />
              <Route path="/projects/:id" element={<ProjectDetailPage />} />
              <Route path="/agents" element={<Navigate to="/settings?tab=operations" replace />} />
              <Route path="/routines" element={<RoutinesPage />} />
              {/* A remote run lives in that machine's task store. */}
              <Route path="/machines/:device/tasks/:id" element={<MachineTaskPage />} />
              <Route path="/usage" element={<Navigate to="/settings?tab=operations" replace />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/agent-sessions/:id" element={<AgentSessionDetailPage />} />
              {/* Developer-only; a production build produces no route here. */}
              {designSystemRoute()}
              <Route path="*" element={<Navigate to="/new" replace />} />
            </Routes>
          </AreaRoute>
        </ErrorBoundary>
      </AppShell>
      <NotificationTaps />
      <ToastHost />
    </>
  );
}
