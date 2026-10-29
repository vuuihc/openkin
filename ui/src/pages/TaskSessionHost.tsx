import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { isTerminal } from "../api/client";
import { usePendingResources, useTaskList, useTaskResource } from "../api/useLiveResources";
import { useT } from "../i18n/react";
import { dropSessionCache, taskIdFromPathname, touchSessionCache } from "../lib/sessionCache";
import { getViewedSessionIds, markSessionViewed, subscribeSessionViewed } from "../lib/sessionViewed";
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
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const activeId = taskIdFromPathname(pathname);
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

  // Active route must appear even before the touch effect commits.
  const ids =
    activeId && !mountedIds.includes(activeId)
      ? touchSessionCache(mountedIds, activeId)
      : mountedIds;

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
    if (!activeTask || taskList.data.some((task) => task.id === activeTask.id)) return taskList.data;
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
        {ids.map((taskId) => {
          const active = taskId === activeId;
          return (
            <div
              key={taskId}
              className={active ? "flex flex-1 min-h-0 min-w-0 flex-col" : "hidden"}
              aria-hidden={!active}
            >
              <ErrorBoundary>
                <TaskDetailPage
                  taskId={taskId}
                  active={active && show}
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
