import { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { useTaskList, useTaskResource } from "../api/useLiveResources";
import { useAgentRoles } from "../hooks/useAgentRoles";
import { useT } from "../i18n/react";
import { rememberLastConversation } from "../lib/lastConversation";
import { dropSessionCache, taskIdFromPathname, touchSessionCache } from "../lib/sessionCache";
import { subscribeWS } from "../store/appStore";
import ErrorBoundary from "../components/ErrorBoundary";
import TaskDetailPage from "./TaskDetailPage";

/**
 * App-level keep-alive for recent task sessions.
 *
 * Stays mounted across route changes (e.g. /tasks/x → /new → /tasks/x).
 * Hidden panes use display:none (clears scrollTop); TaskDetailPage saves and
 * restores it.
 *
 * It owns one list: `mountedIds`, the sessions with a live component right now.
 * Memory is capped at `MAX_CACHED_SESSIONS`, and this cache is the only reason
 * going back to a conversation keeps its scroll and expansion state. There is
 * no second open-tab list — the conversation list is the one place that says
 * what exists, and the route says which one is in front.
 */
export default function TaskSessionHost() {
  const tr = useT();
  // One read for every pane this host keeps alive: the composer's `/` menu
  // lists these. Reading per pane would be up to eight settings fetches at app
  // start for one list that only changes on the settings route — which
  // announces its save, so this stays current without a per-pane read.
  const agentRoles = useAgentRoles();
  const { pathname } = useLocation();
  const activeId = taskIdFromPathname(pathname);
  // A cold start reopens the conversation that was last on screen, not the
  // draft. This is the id `StartRoute` reads when `/` is opened.
  useEffect(() => {
    if (activeId) rememberLastConversation(activeId);
  }, [activeId]);
  const [mountedIds, setMountedIds] = useState<string[]>([]);
  // The same live list the sidebar and /sessions read, keyed identically, so
  // this is a second reader of one subscription rather than a second poll. It
  // is where the pane's fallback row comes from on a cold entry.
  const taskList = useTaskList({ limit: 100 });
  const tasksById = useMemo(
    () => new Map(taskList.data.map((task) => [task.id, task])),
    [taskList.data],
  );

  // The active session can be older than the loaded page, so its row comes
  // from the detail subscription the pane already holds — this is one more
  // reader of that lease, not another request.
  const activeDetail = useTaskResource(activeId ?? "", Boolean(activeId));

  /**
   * The pane the reader actually sees.
   *
   * Opening a conversation from the list mounts its pane and asks for its
   * detail. Until that answer arrives the new pane has nothing to draw, and
   * drawing *it* — a skeleton where a conversation was — is the white flash
   * this host exists to avoid. So the previously shown pane stays on screen
   * while the new one loads, with a thin progress line saying the switch is
   * happening; the replacement is a content swap inside the same shell, not a
   * page load.
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
  // The pane kept on screen can be closed while the next one loads (the task is
  // deleted). It is then not drawn at all, so holding on to it would hide the
  // incoming pane too and leave the area blank. Fall back to the route: the
  // incoming pane draws its own first load, which is honest — there is no
  // earlier conversation left to keep.
  const shownMounted = shownId !== null && ids.includes(shownId);
  const visibleId = switching && shownMounted ? shownId : activeId;

  // Opening a session route mounts its pane.
  useEffect(() => {
    if (!activeId) return;
    setMountedIds((prev) => touchSessionCache(prev, activeId));
  }, [activeId]);

  // A deleted task leaves a dead pane behind. The pane would render "not
  // found"; dropping it here is what closes the screen with the row.
  useEffect(() => {
    return subscribeWS((msg) => {
      if (msg.kind !== "task_deleted") return;
      setMountedIds((prev) => dropSessionCache(prev, msg.data.id));
    });
  }, []);

  const show = Boolean(activeId);

  return (
    <div className={show ? "relative flex flex-1 min-h-0 min-w-0 flex-col" : "hidden"}>
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
  );
}
