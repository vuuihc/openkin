import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { usePendingResources, useTaskList, useTaskResource } from "../api/useLiveResources";
import { useAgentRoles } from "../hooks/useAgentRoles";
import { useMachines } from "../hooks/useMachines";
import { useT } from "../i18n/react";
import type { Machine } from "../lib/devices";
import { rememberLastConversation } from "../lib/lastConversation";
import { THIS_MACHINE } from "../lib/routineDevice";
import { dropSessionCache, taskIdFromPathname, touchSessionCache } from "../lib/sessionCache";
import { getViewedSessionIds, subscribeSessionViewed } from "../lib/sessionViewed";
import { peekPendingSend } from "../lib/pendingSend";
import { tabMark, waitingTaskIds } from "../lib/sessionSwitcher";
import {
  closeSessionTab,
  moveSessionTab,
  neighbourTab,
  openSessionTab,
  readSessionTabs,
  writeSessionTabs,
} from "../lib/sessionTabs";
import { taskDisplayTitle } from "../lib/taskTitle";
import { useLocalTaskTitles } from "../lib/taskTitles";
import { subscribeWS } from "../store/appStore";
import ErrorBoundary from "../components/ErrorBoundary";
import SessionTabs, { type SessionTab } from "../components/layout/SessionTabs";
import TaskDetailPage from "./TaskDetailPage";
import { RemoteTaskRunView } from "./MachineTaskPage";

/**
 * The device a run lives on, when that is not this console's own machine.
 *
 * Empty and the literal "self" both mean here, and the machine list knows the
 * third spelling — the Hub's own device id — and turns that into "here" too.
 * A device this console cannot see still counts as remote: the run is not in
 * this store either, and the read-only view says the machine is gone rather
 * than opening a local page that would answer "not found".
 */
function remoteDeviceId(machines: Machine[], raw: string | undefined): string {
  const id = (raw ?? "").trim();
  if (!id || id === THIS_MACHINE) return "";
  return machines.some((machine) => machine.isSelf && machine.id === id) ? "" : id;
}

/**
 * App-level keep-alive for recent task sessions (Chrome-tab style).
 *
 * Stays mounted across route changes (e.g. /tasks/x → /new → /tasks/x).
 * Hidden panes use display:none (clears scrollTop); TaskDetailPage saves/restores it.
 *
 * It owns the two lists a session appears in, which are not the same list (P3
 * plan §2.6):
 *
 * - `mountedIds` — which sessions have a live component right now. Memory, capped
 *   at `MAX_CACHED_SESSIONS`, and the only reason switching tabs keeps scroll and
 *   expansion state.
 * - `tabOrder` — which sessions are open and in what order. Persisted, so a
 *   reload draws the same strip; but a restored tab is only a name until it is
 *   opened, which is why a reload does not mount eight sessions and open eight
 *   streams at once. The cost is stated in the plan: a tab you have not opened
 *   since the reload starts fresh.
 */
export default function TaskSessionHost() {
  const tr = useT();
  // One read for every pane this host keeps alive: the composer's `/` menu
  // lists these. Reading per pane would be up to eight settings fetches at app
  // start for one list that only changes on the settings route — which
  // announces its save, so this stays current without a per-pane read.
  const agentRoles = useAgentRoles();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const activeId = taskIdFromPathname(pathname);
  const { machines } = useMachines();
  // `?device=` is how a run says which machine owns its transcript (TASTE 12).
  // It is read here, not from the path, because the task detail route is the
  // same for local and remote runs.
  const queryDevice = useMemo(
    () => (new URLSearchParams(search.split("#", 1)[0]).get("device") ?? "").trim(),
    [search],
  );
  // A cold start reopens the conversation that was last on screen, not the
  // draft. This is the id `StartRoute` reads when `/` is opened. A remote run
  // is not a conversation in this store, so it is not remembered as one; that
  // write waits for the remote decision below.
  const [mountedIds, setMountedIds] = useState<string[]>([]);
  const [tabOrder, setTabOrder] = useState<string[]>(() => readSessionTabs());
  // The same live list the sidebar and /sessions read, keyed identically, so this
  // is a second reader of one subscription rather than a second poll. It is where
  // tab names come from: storage holds ids only.
  const taskList = useTaskList({ limit: 100 });
  const tasksById = useMemo(
    () => new Map(taskList.data.map((task) => [task.id, task])),
    [taskList.data],
  );
  // A rename is a local preference and never reaches the live feed, so this
  // strip has to hear the store itself: without the subscription an idle
  // conversation keeps the old tab label above a header showing the new one.
  const [localTitles] = useLocalTaskTitles();

  // Which sessions need the reader. A mid-run block shows in the task's own
  // status too, but the pending lists also cover the moment before it lands.
  const pending = usePendingResources();
  const pendingIds = useMemo(
    () => waitingTaskIds(pending.data.approvals, pending.data.questions),
    [pending.data],
  );
  // Viewed state is localStorage plus an event. The snapshot is a string, like
  // Sidebar's, because `getViewedSessionIds()` returns a fresh array and
  // `useSyncExternalStore` compares snapshots with Object.is.
  const viewedKey = useSyncExternalStore(
    subscribeSessionViewed,
    () => getViewedSessionIds().slice().sort().join(","),
    () => "",
  );
  const viewedIds = useMemo(() => new Set(viewedKey ? viewedKey.split(",") : []), [viewedKey]);

  /**
   * The pane the reader actually sees.
   *
   * Switching sessions mounts a new pane and asks for its detail. Until that
   * answer arrives the new pane has nothing to draw, and drawing *it* — a
   * skeleton where a conversation was — is the white flash this host exists to
   * avoid. So the previously shown pane stays on screen while the new one
   * loads, with a thin progress line saying the switch is happening; the
   * replacement is a content swap inside the same shell, not a page load.
   *
   * `shownId` only advances when the active pane can draw itself. A second
   * switch made during the first one therefore keeps the last pane that had
   * content, not the intermediate one that never appeared.
   *
   * "Can draw itself" is not only "its detail answered". A conversation the
   * console just created is fully drawn from what the create answer already
   * gave us — the list row carries the header and composer, and the draft's
   * handed-over bubble carries the transcript — so waiting for the GET would
   * hold the *previous* conversation in front for a request the new pane does
   * not need. Readiness accepts that row and that handoff.
   *
   * The handoff alone is only a bridge, not a permanent source: this pane's
   * child consumes it on mount, and the seeded list row anchors readiness after
   * that. A cold entry has neither and still waits, honestly.
   */
  const [shownId, setShownId] = useState<string | null>(null);
  // The create answer seeds the live list through `applyTaskSnapshot`, so the
  // row is the anchor; a pane's own `gone` reads still outrank it, so a deleted
  // conversation cannot come back just because a stale list still names it.
  const activeRow = activeId ? tasksById.get(activeId) : undefined;
  // The URL's device wins. Failing that, the list row already in hand names the
  // machine that executed the task, so a row linking `/tasks/<id>` from another
  // machine opens the read-only run instead of a local page that would 404.
  // This is decided before `useTaskResource` so a remote id is never asked of
  // this Hub's task table.
  const remoteDevice = remoteDeviceId(machines, queryDevice || activeRow?.executing_device_id);
  const remoteRun = Boolean(activeId && remoteDevice);
  useEffect(() => {
    if (activeId && !remoteRun) rememberLastConversation(activeId);
  }, [activeId, remoteRun]);
  // The active session can be older than the loaded page (the tab order
  // persists across reloads, the list is the newest hundred), so its readiness
  // comes from the detail subscription the pane already holds — one more reader
  // of that lease, not another request.
  const activeDetail = useTaskResource(activeId ?? "", Boolean(activeId) && !remoteRun);
  const activeHandoff = activeId ? peekPendingSend(activeId) : null;
  const activeReady =
    Boolean(activeId) &&
    !remoteRun &&
    (activeDetail.loaded || Boolean(activeRow) || Boolean(activeHandoff));
  useEffect(() => {
    if (!activeId) {
      setShownId(null);
      return;
    }
    if (activeReady) setShownId(activeId);
  }, [activeId, activeReady]);
  // Active route must appear even before the touch effect commits. A remote run
  // is not a conversation tab, so it never enters this cache.
  const ids =
    remoteRun || !activeId || mountedIds.includes(activeId)
      ? mountedIds
      : touchSessionCache(mountedIds, activeId);
  const switching =
    !remoteRun &&
    Boolean(activeId) &&
    !activeReady &&
    Boolean(shownId) &&
    shownId !== activeId;
  // The pane kept on screen can be closed while the next one loads (its tab is
  // closed, or the task is deleted). It is then not drawn at all, so holding on
  // to it would hide the incoming pane too and leave the area blank. Fall back
  // to the route: the incoming pane draws its own first load, which is honest —
  // there is no earlier conversation left to keep.
  const shownMounted = shownId !== null && ids.includes(shownId);
  const visibleId = switching && shownMounted ? shownId : activeId;

  // Opening a session route opens (or revisits) its tab and mounts it. A run
  // on another machine is not one of this machine's conversations, so it gets
  // neither a tab nor a mounted local pane.
  useEffect(() => {
    if (!activeId || remoteRun) return;
    setMountedIds((prev) => touchSessionCache(prev, activeId));
    setTabOrder((prev) => {
      const next = openSessionTab(prev, activeId);
      // Identity means "already open and nothing evicted", which is the common
      // case (every revisit) and should not cost a write.
      if (next !== prev) writeSessionTabs(next);
      return next;
    });
  }, [activeId, remoteRun]);

  // A deleted task leaves two dead entries behind: a mounted pane and a tab. The
  // pane would render "not found"; the tab would stay until it was clicked.
  useEffect(() => {
    return subscribeWS((msg) => {
      if (msg.kind !== "task_deleted") return;
      setMountedIds((prev) => dropSessionCache(prev, msg.data.id));
      setTabOrder((prev) => {
        const next = closeSessionTab(prev, msg.data.id);
        if (next !== prev) writeSessionTabs(next);
        return next;
      });
    });
  }, []);

  const selectTab = useCallback(
    (id: string) => {
      if (id !== activeId) navigate(`/tasks/${encodeURIComponent(id)}`);
    },
    [activeId, navigate],
  );

  const closeTab = useCallback(
    (id: string) => {
      // Read the neighbour before the write: after it, the closing tab is gone
      // from the order and there is nothing left to ask.
      const next = neighbourTab(tabOrder, id);
      setMountedIds((prev) => dropSessionCache(prev, id));
      setTabOrder((prev) => {
        const closed = closeSessionTab(prev, id);
        if (closed !== prev) writeSessionTabs(closed);
        return closed;
      });
      if (id === activeId) navigate(next ? `/tasks/${encodeURIComponent(next)}` : "/sessions");
    },
    [activeId, navigate, tabOrder],
  );

  const moveTab = useCallback((id: string, delta: number) => {
    setTabOrder((prev) => {
      const moved = moveSessionTab(prev, id, delta);
      if (moved !== prev) writeSessionTabs(moved);
      return moved;
    });
  }, []);

  const tabs: SessionTab[] = tabOrder.map((id) => ({
    id,
    label: taskDisplayTitle(tasksById.get(id), localTitles) || tr("tabs.untitled"),
    // The session in front carries no dot: its state is the screen itself, and
    // a mark there would label what the reader is already looking at.
    mark:
      id === activeId ? null : tabMark(tasksById.get(id), viewedIds.has(id), pendingIds.has(id)),
  }));

  const show = Boolean(activeId);

  return (
    // With no active session the strip is all there is to draw, and the route
    // below it (the draft, the session list) keeps the rest of the column; with
    // neither, nothing is drawn at all.
    <div
      className={
        show
          ? "relative flex flex-1 min-h-0 min-w-0 flex-col"
          : tabs.length
            ? "flex-none"
            : "hidden"
      }
    >
      {/* Session tabs are shell chrome, not reading chrome. Below 1600 the
          strip sat inside the transcript's measured top offset and the reading
          surface paid for it on every screen; the list column is visible at
          820/1100 (and the header keeps its show-list control), so switching
          stays one action away. The strip returns with the side rail. */}
      <div className="hidden min-[1600px]:block">
        <SessionTabs
          tabs={tabs}
          activeId={activeId}
          onSelect={selectTab}
          onClose={closeTab}
          onMove={moveTab}
        />
      </div>
      <div
        className={show ? "relative flex flex-1 min-h-0 min-w-0 flex-col" : "hidden"}
        aria-hidden={!show}
      >
        {switching ? (
          // Thin, at the top, over the outgoing conversation: it says "this is
          // changing" without taking height from the content that is still
          // readable or moving the composer under the reader's hands.
          <div
            role="progressbar"
            aria-label={tr("common.loading")}
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 overflow-hidden bg-kin-blue/15"
          >
            <div className="h-full w-1/3 animate-pulse bg-kin-blue" />
          </div>
        ) : null}
        {/* The run on another machine is the same task detail: it keeps its own
            loading line (TASTE 15), so it is not wrapped in the switch bar. The
            key is the visit: a previous run's late answer must not paint here. */}
        {remoteRun && activeId ? (
          <RemoteTaskRunView
            key={`${remoteDevice}\u0000${activeId}`}
            device={remoteDevice}
            id={activeId}
          />
        ) : null}
        {/* Local panes stay mounted while a remote run is open — switching back
            keeps their scroll and expansion — but they are not drawn and not
            reachable by the keyboard. */}
        <div className={remoteRun ? "hidden" : "contents"} aria-hidden={remoteRun || undefined}>
          {ids.map((taskId) => {
            const visible = taskId === visibleId;
            // The keys follow what is on screen, not the address bar. During a
            // switch the outgoing conversation is the one being read, so it owns
            // `a`/`d`/⌘F until the new pane has content; the incoming pane is
            // hidden and must not decide an approval nobody can see.
            return (
              <div
                key={taskId}
                className={visible ? "flex flex-1 min-h-0 min-w-0 flex-col" : "hidden"}
                aria-hidden={!visible}
              >
                <ErrorBoundary>
                  <TaskDetailPage
                    taskId={taskId}
                    active={visible && show}
                    // The list row this host already holds is enough to draw the
                    // header and composer on a cold entry; the detail fills the
                    // transcript when it arrives.
                    fallbackTask={tasksById.get(taskId)}
                    agentRoles={agentRoles}
                  />
                </ErrorBoundary>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
