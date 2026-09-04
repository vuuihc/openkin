import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  liveResources,
  taskListKey,
  type TaskListParams,
} from "./liveResources";

function useLiveState() {
  return useSyncExternalStore(
    liveResources.subscribe,
    liveResources.getSnapshot,
    liveResources.getSnapshot,
  );
}

export function useTaskList(params: TaskListParams, enabled = true) {
  const key = taskListKey(params);
  const stableParams = useMemo(() => params, [key]);
  const state = useLiveState();
  useEffect(() => {
    if (!enabled) return;
    return liveResources.acquireTaskList(stableParams);
  }, [enabled, stableParams]);
  return state.taskLists[key] ?? liveResources.getTaskList(key);
}

export function usePendingResources(enabled = true) {
  const state = useLiveState();
  useEffect(() => {
    if (!enabled) return;
    return liveResources.acquirePending();
  }, [enabled]);
  return state.pending;
}

export function useTaskResource(taskId: string, enabled = true) {
  const state = useLiveState();
  useEffect(() => {
    if (!enabled || !taskId) return;
    return liveResources.acquireTask(taskId);
  }, [enabled, taskId]);
  return state.taskDetails[taskId] ?? liveResources.getTaskDetail(taskId);
}
