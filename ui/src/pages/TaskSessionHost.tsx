import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isTerminal } from "../api/client";
import { usePendingResources, useTaskList, useTaskResource } from "../api/useLiveResources";
import { useAgentRoles } from "../hooks/useAgentRoles";
import { useT } from "../i18n/react";
import { rememberLastConversation } from "../lib/lastConversation";
import { dropSessionCache, taskIdFromPathname, touchSessionCache } from "../lib/sessionCache";
import {
  getViewedSessionIds,
  markSessionViewed,
  subscribeSessionViewed,
} from "../lib/sessionViewed";
import { attentionMark, buildSwitcherRows, tabMark, waitingTaskIds } from "../lib/sessionSwitcher";
import {
  closeSessionTab,
  moveSessionTab,
  neighbourTab,
  openSessionTab,
  readSessionTabs,
  writeSessionTabs,
} from "../lib/sessionTabs";
import { taskDisplayTitle } from "../lib/taskTitle";
import { subscribeWS } from "../store/appStore";
import ErrorBoundary from "../components/ErrorBoundary";
import SessionTabs, { type SessionTab } from "../components/layout/SessionTabs";
import SessionSwitcherSheet from "../components/mobile/SessionSwitcherSheet";
import TaskDetailPage from "./TaskDetailPage";

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
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const activeId = taskIdFromPathname(pathname);
  // A cold start reopens the conversation that was last on screen, not the
  // draft. This is the id `StartRoute` reads when `/` is opened.
  useEffect(() => {
    if (activeId) rememberLastConversation(activeId);
  }, [activeId]);
  const [mountedIds, setMountedIds] = useState<string[]>([]);
  const [tabOrder, setTabOrder] = useState<string[]>(() => readSessionTabs());
  /** The phone's session switcher (the tab strip is desktop-only). */
  const [switcherOpen, setSwitcherOpen] = useState(false);
  // The same live list the sidebar and /sessions read, keyed identically, so this
  // is a second reader of one subscription rather than a second poll. It is where
  // tab names come from: storage holds ids only.
  const taskList = useTaskList({ limit: 100 });
  const tasksById = useMemo(
    () => new Map(taskList.data.map((task) => [task.id, task])),
    [taskList.data],
  );

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

  // The active session can be older than the loaded page (the tab order
  // persists across reloads, the list is the newest hundred), so its row comes
  // from the detail subscription the pane already holds — this is one more
  // reader of that lease, not another request.
  const activeDetail = useTaskResource(activeId ?? "", Boolean(activeId));
  const activeTask = activeDetail.data.task ?? (activeId ? tasksById.get(activeId) : undefined);

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
   * `shownId` only advances when the active pane has loaded. A second switch
   * made during the first one therefore keeps the last pane that had content,
   * not the intermediate one that never appeared.
   */
  const [shownId, setShownId] = useState<string | null>(null);
  const activeReady = Boolean(activeId) && activeDetail.loaded;
  useEffect(() => {
    if (!activeId) {
      setShownId(null);
      return;
    }
    if (activeReady) setShownId(activeId);
  }, [activeId, activeReady]);
  // Active route must appear even before the touch effect commits.
  const ids =
    activeId && !mountedIds.includes(activeId)
      ? touchSessionCache(mountedIds, activeId)
      : mountedIds;
  const switching = Boolean(activeId) && !activeReady && Boolean(shownId) && shownId !== activeId;
  // The pane kept on screen can be closed while the next one loads (its tab is
  // closed, or the task is deleted). It is then not drawn at all, so holding on
  // to it would hide the incoming pane too and leave the area blank. Fall back
  // to the route: the incoming pane draws its own first load, which is honest —
  // there is no earlier conversation left to keep.
  const shownMounted = shownId !== null && ids.includes(shownId);
  const visibleId = switching && shownMounted ? shownId : activeId;

  // Asking "what is new?" is the moment the session in front of the reader
  // stops being new. Marked here rather than on every status change: the
  // desktop sidebar deliberately keeps its green dot when a watched session
  // finishes (see Sidebar's `handledSelectionRef`), and this control exists
  // only on the phone.
  const openSwitcher = useCallback(() => {
    if (activeId && activeTask && isTerminal(activeTask.status)) {
      markSessionViewed(activeId);
    }
    setSwitcherOpen(true);
  }, [activeId, activeTask]);

  // Opening a session route opens (or revisits) its tab and mounts it.
  useEffect(() => {
    if (!activeId) return;
    setMountedIds((prev) => touchSessionCache(prev, activeId));
    setTabOrder((prev) => {
      const next = openSessionTab(prev, activeId);
      // Identity means "already open and nothing evicted", which is the common
      // case (every revisit) and should not cost a write.
      if (next !== prev) writeSessionTabs(next);
      return next;
    });
  }, [activeId]);

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
    label: taskDisplayTitle(tasksById.get(id)) || tr("tabs.untitled"),
    // The session in front carries no dot: its state is the screen itself, and
    // a mark there would label what the reader is already looking at.
    mark:
      id === activeId ? null : tabMark(tasksById.get(id), viewedIds.has(id), pendingIds.has(id)),
  }));

  // The active row is drawn from the same list as the rest; if it fell off the
  // page it is prepended so the session in front of the reader keeps its name
  // and state instead of turning into an untitled idle row.
  const switcherTasks = useMemo(() => {
    if (!activeTask || taskList.data.some((task) => task.id === activeTask.id))
      return taskList.data;
    return [activeTask, ...taskList.data];
  }, [activeTask, taskList.data]);

  const switcherRows = useMemo(
    () =>
      buildSwitcherRows({
        tabIds: tabOrder,
        tasks: switcherTasks,
        activeId,
        viewedIds,
        pendingIds,
        untitled: tr("tabs.untitled"),
      }),
    [tabOrder, switcherTasks, activeId, viewedIds, pendingIds, tr],
  );

  // The same rows the sheet will draw, read for the one thing the phone's
  // control can say without being opened.
  const switcherMark = useMemo(() => attentionMark(switcherRows), [switcherRows]);

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
      <SessionTabs
        tabs={tabs}
        activeId={activeId}
        onSelect={selectTab}
        onClose={closeTab}
        onMove={moveTab}
      />
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
                  agentRoles={agentRoles}
                  onOpenSessionSwitcher={openSwitcher}
                  switcherMark={switcherMark}
                />
              </ErrorBoundary>
            </div>
          );
        })}
      </div>
      <SessionSwitcherSheet
        open={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
        rows={switcherRows}
        onSelect={(id) => {
          selectTab(id);
          setSwitcherOpen(false);
        }}
      />
    </div>
  );
}
