import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTaskList } from "../api/useLiveResources";
import { useT } from "../i18n/react";
import { dropSessionCache, taskIdFromPathname, touchSessionCache } from "../lib/sessionCache";
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
  // The same live list the sidebar and /sessions read, keyed identically, so this
  // is a second reader of one subscription rather than a second poll. It is where
  // tab names come from: storage holds ids only.
  const taskList = useTaskList({ limit: 100 });
  const tasksById = useMemo(
    () => new Map(taskList.data.map((task) => [task.id, task])),
    [taskList.data],
  );

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
                <TaskDetailPage taskId={taskId} active={active && show} />
              </ErrorBoundary>
            </div>
          );
        })}
      </div>
    </div>
  );
}
