import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  dropSessionCache,
  taskIdFromPathname,
  touchSessionCache,
} from "../lib/sessionCache";
import { subscribeWS } from "../store/appStore";
import ErrorBoundary from "../components/ErrorBoundary";
import TaskDetailPage from "./TaskDetailPage";

/**
 * App-level keep-alive for recent task sessions (Chrome-tab style).
 *
 * Stays mounted across route changes (e.g. /tasks/x → /new → /tasks/x).
 * Scroll lives in the DOM — no save/restore of scrollTop.
 */
export default function TaskSessionHost() {
  const { pathname } = useLocation();
  const activeId = taskIdFromPathname(pathname);
  const [cachedIds, setCachedIds] = useState<string[]>([]);

  // Touch cache when opening a task route.
  useEffect(() => {
    if (!activeId) return;
    setCachedIds((prev) => touchSessionCache(prev, activeId));
  }, [activeId]);

  // Drop deleted tasks so we don't keep dead instances forever.
  useEffect(() => {
    return subscribeWS((msg) => {
      if (msg.kind !== "task_deleted") return;
      const data = msg.data as { id?: string };
      if (!data?.id) return;
      setCachedIds((prev) => dropSessionCache(prev, data.id!));
    });
  }, []);

  // Active route must appear even before the touch effect commits.
  const ids =
    activeId && !cachedIds.includes(activeId)
      ? touchSessionCache(cachedIds, activeId)
      : cachedIds;

  const show = Boolean(activeId);

  return (
    <div
      className={
        show
          ? "relative flex flex-1 min-h-0 min-w-0 flex-col"
          : "hidden"
      }
      aria-hidden={!show}
    >
      {ids.map((taskId) => {
        const active = taskId === activeId;
        return (
          <div
            key={taskId}
            className={
              active
                ? "flex flex-1 min-h-0 min-w-0 flex-col"
                : "hidden"
            }
            aria-hidden={!active}
          >
            <ErrorBoundary>
              <TaskDetailPage taskId={taskId} active={active && show} />
            </ErrorBoundary>
          </div>
        );
      })}
    </div>
  );
}
