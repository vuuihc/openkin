import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { getToken, getRoutineUnreadCount } from "./api/client";
import { liveResources } from "./api/liveResources";
import { SessionSync } from "./api/sessionSync";
import { usePendingResources } from "./api/useLiveResources";
import ConnectScreen from "./components/ConnectScreen";
import NotificationTaps from "./components/NotificationTaps";
import AppShell from "./components/layout/AppShell";
import AreaRoute from "./components/layout/AreaRoute";
import ToastHost from "./components/ToastHost";
import { designSystemRoute } from "./pages/DesignSystemPage";
import NewChatPage from "./pages/NewChatPage";
import SessionsRoute from "./pages/SessionsRoute";
import StartRoute from "./pages/StartRoute";
import SettingsPage from "./pages/SettingsPage";
import TaskSessionHost from "./pages/TaskSessionHost";
import TrayPage from "./pages/TrayPage";
import RoutinesPage from "./pages/RoutinesPage";
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

/**
 * The retired remote-run URL (KIN-CONTRACT-001).
 *
 * A run on another machine now opens on the one task detail page, with
 * `?device=` saying where its transcript lives. The old path survives as a
 * replace-only redirect so a bookmark, a banner or a phone notification written
 * before the move still lands; `replace` keeps Back from returning to a URL
 * that immediately leaves again. The device in the path wins over one already
 * in the query, and the rest of the query (`?focus=` and friends) rides along.
 */
function MachineTaskRedirect() {
  const { device = "", id = "" } = useParams();
  const { search } = useLocation();
  const params = new URLSearchParams();
  params.set("device", device);
  for (const [key, value] of new URLSearchParams(search.split("#", 1)[0])) {
    if (key === "device") continue;
    params.append(key, value);
  }
  return <Navigate to={`/tasks/${encodeURIComponent(id)}?${params.toString()}`} replace />;
}

/**
 * The retired project cover (KIN-CONTRACT-001).
 *
 * A project has no page of its own: its conversations are a narrowing of the
 * one conversation list (`?project=`), and its work instructions, summary and
 * working folders are edited from that list's project row. An old
 * `/projects/:id` bookmark, notification or Back entry therefore replaces
 * itself with the narrowed list — `replace`, like `/projects` and `/inbox`, so
 * Back does not return to a URL that immediately leaves again.
 */
function ProjectCoverRedirect() {
  const { id = "" } = useParams();
  return <Navigate to={`/sessions?project=${encodeURIComponent(id)}`} replace />;
}

/**
 * The imported agent session's entry (KIN-CONTRACT-001:137, R-agent-retire 5a).
 *
 * An imported session is a surface of the conversation list, not a screen of
 * its own: the row opens its sheet over the list, and the list stays the
 * reader's place. A notification, bookmark or cross-device link that names the
 * old page therefore replaces itself with the same list, narrowed by
 * `?agent=<id>`, and the list opens that session's sheet. `replace`, like the
 * project cover above, keeps Back from returning to a URL that leaves again.
 * The route's final landing is the sheet's own continue: 5b deleted the page
 * that used to draw here, and continuing lands on `/tasks/<id>`.
 */
export function AgentSessionEntryRedirect() {
  const { id = "" } = useParams();
  return <Navigate to={`/sessions?agent=${encodeURIComponent(id)}`} replace />;
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
              {/* KIN-CONTRACT-001 retired the Projects area, its collection and
                  the project cover: the project level is the conversation
                  list's own headings, and narrowing that list by `?project=` is
                  what the cover used to be. A bookmark or notification that
                  names either URL lands on that list, the same way `/inbox` and
                  `/approvals` do. `App.areaRoutes.test.ts` pins both. */}
              <Route path="/projects" element={<Navigate to="/sessions" replace />} />
              <Route path="/projects/:id" element={<ProjectCoverRedirect />} />
              {/* Agent operations live in Settings → Operations, so the old
                  full-page destinations redirect there: a bookmark, banner or
                  notification from before E4a still lands on the panel. */}
              <Route path="/agents" element={<Navigate to="/settings?tab=operations" replace />} />
              <Route path="/routines" element={<RoutinesPage />} />
              {/* A remote run is the task detail with `?device=`; the old
                  machine path is a replace-only redirect kept for old links. */}
              <Route path="/machines/:device/tasks/:id" element={<MachineTaskRedirect />} />
              <Route path="/usage" element={<Navigate to="/settings?tab=operations" replace />} />
              <Route path="/settings" element={<SettingsPage />} />
              {/* An imported session opens in the list's sheet (5a); its old
                  URL is the same list narrowed by `?agent=`. 5b deleted the
                  page file, so continuing from the sheet is what reaches the
                  conversation. */}
              <Route path="/agent-sessions/:id" element={<AgentSessionEntryRedirect />} />
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
