import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  archiveTask,
  isTerminal,
  listAgentSessionsPage,
  listTasks,
  unarchiveTask,
  type AgentSession,
  type Task,
} from "../api/client";
import { useTaskList } from "../api/useLiveResources";
import { liveResources } from "../api/liveResources";
import { useMachines } from "../hooks/useMachines";
import { agentAvatarMeta, agentDisplayName } from "../lib/agentMention";
import { formatRelativeTime } from "../lib/relativeTime";
import {
  archivedCwdFor,
  filterProjectBuckets,
  groupProjectBucketsByDevice,
  phoneProjectBuckets,
  PINNED_BUCKET,
  pinnedRowDeviceName,
  withPinnedBucket,
  type PhoneProjectBucket,
  type PhoneSessionRow,
} from "../lib/phoneSessionBuckets";
import { type Machine } from "../lib/devices";
import { getPinnedTaskIds, setTaskPinned } from "../lib/taskPins";
import { consumeRowReturn, rememberRowReturn, takeRowReturn } from "../lib/rowReturn";
import { sessionListParams } from "../lib/sessionListParams";
import { sessionFeedTasks } from "../lib/sessionFeed";
import { settleArchiveBatch } from "../lib/archiveBatch";
import { rowSelectable, selectableTaskIds } from "../lib/sessionSelection";
import {
  getViewedSessionIds,
  markSessionViewed,
  sessionStatusDotClass,
} from "../lib/sessionViewed";
import { taskCardStatusView } from "../lib/taskCardStatus";
import { mergeTaskTail } from "../lib/taskTail";
import {
  getArchivedProjects,
  subscribeProjectSidebar,
  unarchiveProject,
} from "../lib/projectSidebar";
import { useLocale, useT } from "../i18n/react";
import { MobileEmpty, MobileScreen } from "../components/mobile/MobileList";
import HighlightedText from "../components/HighlightedText";
import SessionsSearch from "../components/mobile/SessionsSearch";
import SessionFilters, {
  normalizeScopeFilter,
  normalizeStatusFilter,
  type SessionScopeFilter,
  type SessionStatusFilter,
} from "../components/ui/SessionFilters";
import {
  IconAlert,
  IconArchive,
  IconCheck,
  IconChevronDown,
  IconFilter,
  IconFolder,
  IconFolderOpen,
  IconMachine,
  IconPin,
  IconRefresh,
  IconRestore,
  IconSessions,
  IconTrash,
} from "../components/icons";
import SwipeReveal from "../components/mobile/SwipeReveal";
import SessionRowActions, {
  sessionRowActionsWidth,
  type SessionRowActionMode,
} from "../components/mobile/SessionRowActions";
import { useSessionDeletion } from "../hooks/useSessionDeletion";
import { useAppStore } from "../store/appStore";

/**
 * The phone's conversation list, grouped by project.
 *
 * The reference phone client is the model: one heading per project with a
 * fold, five rows before "show all", and flat rows — status dot, agent mark,
 * one line of title, the time at the tail. The previous version grouped by
 * machine and then by day, which turned the screen into a chronological log:
 * the thing a person is looking for is the project they were working in, and a
 * machine is a property of a session rather than a place to browse.
 *
 * Search is in `?q=`, so the header and the list cannot disagree and a reload
 * keeps the query. The field filters the loaded rows on the same frame, and the
 * server answers the same string a beat later over the whole library — the
 * loaded page is 100 rows, and a conversation from last month is not in it. The
 * two use the same predicate shape (title / prompt / cwd / agent / id), so the
 * local narrowing never shows a row the server would have dropped.
 */

const ROWS_BEFORE_SHOW_ALL = 5;

/** A stable empty set, so the memos below keep one identity across renders. */
const EMPTY_IDS: ReadonlySet<string> = new Set();

/**
 * How long typing settles before the query leaves the browser.
 *
 * Without it every keystroke is a request and a new live-list subscription;
 * with it the field still filters what is already loaded on the same frame
 * (`filterProjectBuckets` below), so the visible rows never lag the characters.
 */
const SEARCH_DEBOUNCE_MS = 200;

export default function SessionsPage() {
  const tr = useT();
  const pushToast = useAppStore((s) => s.pushToast);
  const { deleteOne, deleteMany } = useSessionDeletion();
  // The memo below bakes copy into the buckets ("No project", "Untitled"), so
  // it has to rebuild on a locale switch — `tr` is a stable function and would
  // never invalidate it.
  const { locale } = useLocale();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  // Filters live in the URL for the same reason the query does: the header
  // control and the list cannot disagree, a reload keeps them, and a filtered
  // list can be linked to. Unknown values are "all", never a filter that
  // nothing can match.
  const status = normalizeStatusFilter(params.get("status"));
  const scope = normalizeScopeFilter(params.get("scope"));
  // The query as the server last saw it. `query` updates per keystroke; this
  // follows after the field settles, and collapses to empty immediately so
  // clearing the box never waits on a timer.
  const [searchTerm, setSearchTerm] = useState(() => query.trim());
  // A row opened from this list asks for the caret back when the reader
  // returns (step 7). The mark is consumed when it lands, so a later keystroke
  // in the search — or a live update — cannot pull the caret back out.
  const [returnRow, setReturnRow] = useState<string | null>(() => takeRowReturn());
  useEffect(() => {
    const next = query.trim();
    if (!next) {
      setSearchTerm("");
      return;
    }
    const timer = setTimeout(() => setSearchTerm(next), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const taskList = useTaskList(sessionListParams(searchTerm, status));
  const { machines, loading: machinesLoading } = useMachines();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  // Older pages, appended by "load older". They live beside the live list
  // rather than inside it: the live store merges websocket updates into its
  // first page, and mixing a static tail into that would make every update
  // re-scan rows that can no longer change.
  const [olderTasks, setOlderTasks] = useState<Task[]>([]);
  // The archive view's tail. It has its own cursor: an archived conversation's
  // id is not a bound in the live list, and paging one feed with the other's
  // cursor either repeats a page forever or skips the rows in between.
  const [olderArchivedTasks, setOlderArchivedTasks] = useState<Task[]>([]);
  const [olderSessions, setOlderSessions] = useState<AgentSession[]>([]);
  // The imported-sessions feed answers with a keyset cursor; the tasks feed
  // has none, so "is there more" is inferred from a full page (`null` = not
  // asked yet).
  const [sessionCursor, setSessionCursor] = useState<string | undefined>(undefined);
  const [taskMore, setTaskMore] = useState<boolean | null>(null);
  const [archiveMore, setArchiveMore] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sessionsFailed, setSessionsFailed] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // Pins are the phone list's own preference (localStorage), like the sidebar's
  // project pins: a pinned task lifts to the top bucket and leaves its project.
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(
    () => new Set(getPinnedTaskIds()),
  );
  // Multi-select, entered by a long press on a row (the reference's pattern).
  // While active, a tap selects instead of opening, and the toolbar owns the
  // batch actions: pin / unpin and archive.
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  // A batch in flight: the toolbar's actions disable and re-entry is refused,
  // so a second tap cannot fire a second round at rows the first is removing.
  const [deletingSelection, setDeletingSelection] = useState(false);
  const deletingSelectionRef = useRef(false);
  // Archiving a batch is the same shape: a second tap must not fire a second
  // round at rows the first is already removing.
  const [archivingSelection, setArchivingSelection] = useState(false);
  const archivingSelectionRef = useRef(false);
  const selectionBusy = deletingSelection || archivingSelection;
  // Which selection a slow batch answered. A search or filter change clears
  // the selection and bumps this, so a batch that lands afterwards cannot put
  // rows nobody selected back into a toolbar.
  const selectionEpoch = useRef(0);
  // One swipe-revealed row at a time, the same rule the message actions use.
  const [swipeOpen, setSwipeOpen] = useState<string | null>(null);
  // Archiving a project from the drawer has to empty this list too, and the
  // archive lives in sidebar prefs: subscribe rather than read once.
  const [prefsTick, setPrefsTick] = useState(0);
  useEffect(() => subscribeProjectSidebar(() => setPrefsTick((n) => n + 1)), []);
  // A different question is a different list. A selection made under the old
  // one would let Delete remove rows the person can no longer see — "select
  // all, then search, then Delete" would arm exactly that. Switching sides of
  // the archive is the same kind of change: the toolbar's actions differ
  // between them.
  useEffect(() => {
    selectionEpoch.current += 1;
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, [query, status, scope]);

  useEffect(() => {
    let cancelled = false;
    // A new query is a new question: the previous answer's failure notice must
    // not sit over rows it never described.
    setSessionsFailed(false);
    // …and the previous tail and cursor belonged to that answer.
    setOlderSessions([]);
    setSessionCursor(undefined);
    const read = () => {
      // The paged route, not the plain one: the cursor is what lets "load
      // older" reach past the first hundred imported sessions. A sync re-read
      // starts from the top, because an import changes what page one holds.
      const term = sessionListParams(searchTerm);
      listAgentSessionsPage({ limit: term.limit, q: term.q })
        .then((page) => {
          if (cancelled) return;
          setSessions(page.items);
          setSessionCursor(page.next_cursor);
          setOlderSessions([]);
          setSessionsFailed(false);
        })
        .catch(() => {
          // Imported sessions are a bonus on this screen, not the point of it:
          // Kin's own tasks still list, so a failed read is not an error state.
          if (!cancelled) setSessionsFailed(true);
        });
    };
    read();
    // The desktop shell publishes this after an import; without it a session
    // imported on the Mac would not appear here until the app was reopened.
    window.addEventListener("kin:agent-sessions-sync", read);
    return () => {
      cancelled = true;
      window.removeEventListener("kin:agent-sessions-sync", read);
    };
  }, [searchTerm]);

  // A different question gets a different page one: the previous tail is not
  // part of this answer, and the "more" hint answered for the old one. The
  // generation lets an older page that is still in flight notice it belongs to
  // a question nobody is asking any more — without it the response lands after
  // the reset and its rows stay under the new filter for good.
  const requestGeneration = useRef(0);
  useEffect(() => {
    requestGeneration.current += 1;
    setOlderTasks([]);
    setOlderArchivedTasks([]);
    setTaskMore(null);
    setArchiveMore(null);
  }, [searchTerm, status]);

  // Re-entering the archive acquires that feed again, and the store may fetch
  // it from scratch, so the previous visit's tail and its "is there more"
  // answer no longer describe it. The live feed is left alone: its key did not
  // change and its resource still holds the page-full answer for that key.
  useEffect(() => {
    if (scope !== "archived") return;
    requestGeneration.current += 1;
    setOlderArchivedTasks([]);
    setArchiveMore(null);
  }, [scope]);

  const selfDeviceId = (machines.find((machine) => machine.isSelf)?.id ?? "").trim();
  // A settled query is a new live-list key, and the hook hands back an empty
  // unloaded resource while it fetches. Without this the whole page would blink
  // to "loading" on every pause in typing. The previous answer stays on screen
  // narrowed by the local filter, so what is shown is never wrong for the
  // current text — just older than the server's answer that follows it.
  const lastLoadedTasks = useRef<readonly Task[]>([]);
  useEffect(() => {
    if (taskList.loaded) lastLoadedTasks.current = taskList.data;
  }, [taskList.loaded, taskList.data]);
  const liveTasks = taskList.loaded ? taskList.data : lastLoadedTasks.current;
  // The archive view's own feed. Kept beside the live list rather than swapped
  // for it: the view shows archived conversations *and* archived projects, and
  // a project's chats are not archived rows. Asked for only while that view is
  // open — every other screen would pay a request it never reads.
  const archivedList = useTaskList(
    sessionListParams(searchTerm, status, true),
    scope === "archived",
  );
  // Same retention as the live feed: a settled search is a new list key, and
  // the hook answers it with an empty resource until the server replies. The
  // previous archive stays on screen narrowed by the local filter; without it
  // the view blinks to a full-screen spinner on every pause in typing.
  const lastLoadedArchivedTasks = useRef<readonly Task[]>([]);
  useEffect(() => {
    // Only a good answer replaces the retained one: a failed re-ask must not
    // throw away the archive that is still on screen.
    if (archivedList.loaded && !archivedList.error) {
      lastLoadedArchivedTasks.current = archivedList.data;
    }
  }, [archivedList.loaded, archivedList.error, archivedList.data]);
  // An errored answer is not a usable one: the store marks it `loaded` with
  // the error attached, and rendering its empty data would turn a failed
  // re-ask into "the archive is empty". The retained rows stay until a good
  // answer replaces them.
  const archivedTasks =
    archivedList.loaded && !archivedList.error
      ? archivedList.data
      : lastLoadedArchivedTasks.current;
  // The live list first, then the older pages a person asked for. The merge
  // asks the live store about each tail id — a row deleted since its page was
  // fetched disappears instead of navigating to a 404, and one that changed
  // status is shown as it is now rather than as it was.
  const liveRows = useMemo(
    () => mergeTaskTail(liveTasks, olderTasks, (id) => liveResources.taskSnapshot(id)),
    [liveTasks, olderTasks],
  );
  // The archive view's tail, reconciled the same way: a row restored from
  // another surface must not linger in this feed as a stale copy.
  const archivedRows = useMemo(
    () => mergeTaskTail(archivedTasks, olderArchivedTasks, (id) => liveResources.taskSnapshot(id)),
    [archivedTasks, olderArchivedTasks],
  );
  // `sessionFeedTasks` picks which of those rows this scope shows; see its
  // comment for why the live side drops archived rows and the archive side
  // adds its own feed.
  const tasks = useMemo(
    () => sessionFeedTasks(liveRows, archivedRows, scope, status),
    [liveRows, archivedRows, status, scope],
  );
  const allSessions = useMemo(() => {
    if (olderSessions.length === 0) return sessions;
    const seen = new Set(sessions.map((session) => session.id));
    return [...sessions, ...olderSessions.filter((session) => !seen.has(session.id))];
  }, [sessions, olderSessions]);
  const taskLimit = sessionListParams(searchTerm, status).limit;
  const archiveLimit = sessionListParams(searchTerm, status, true).limit;
  // "Is there more" is asked per feed. The answer comes from the resource,
  // which recorded whether the server's page was full before live updates
  // started shrinking it: a full first page minus one archived row is still a
  // full page, and re-reading the array would hide the tail. The length
  // check is the other direction — the shell holds the unfiltered key for the
  // life of the app, and a short answer plus enough new rows can fill it
  // again after evicting the oldest loaded ones, which means the window is no
  // longer the whole list. Once a person pages, the tail's own answer wins
  // (`taskMore`/`archiveMore`), because the first page no longer describes
  // where the tail ended.
  const hasMoreTasks = taskMore ?? (taskList.pageFull || liveTasks.length >= taskLimit);
  const hasMoreArchive =
    scope === "archived" &&
    (archiveMore ?? (archivedList.pageFull || archivedTasks.length >= archiveLimit));
  // Imported sessions carry no status, so a status filter excludes them rather
  // than showing rows that cannot match it.
  const hasMoreSessions = Boolean(sessionCursor) && !status;
  // `prefsTick` is the invalidation: it changes when the drawer archives or
  // restores a project, and the memo below has to rebuild then.
  const archivedCwds = useMemo(() => getArchivedProjects(), [prefsTick]);
  const buckets = useMemo(
    () =>
      phoneProjectBuckets(
        tasks,
        // A status filter is a question about Kin's own tasks; imported
        // sessions have no status, so they cannot answer it.
        status ? [] : allSessions,
        selfDeviceId,
        {
          untitled: tr("sessions.untitled"),
          noProject: tr("sessions.noProject"),
        },
        archivedCwds,
        scope,
      ),
    [tasks, allSessions, status, scope, selfDeviceId, locale, archivedCwds],
  );
  const filtered = useMemo(() => filterProjectBuckets(buckets, query), [buckets, query]);
  // Pinned rows leave their project buckets and lead the list. Not in the
  // archived view: a pin lifts a row out of the project it is filed under, and
  // that view exists to show projects as filed — a "Pinned" bucket there would
  // also carry rows whose pin/archive actions are hidden.
  const listed = useMemo(
    () =>
      withPinnedBucket(
        filtered,
        scope === "archived" ? EMPTY_IDS : pinnedIds,
        tr("sessions.pinned"),
      ),
    [filtered, pinnedIds, scope, tr],
  );
  // The rows exist only after the task list arrives; retry as it fills until
  // the marked row is on screen. Once it is, the mark is cleared and this
  // effect has nothing left to do, whatever else re-renders the list.
  useEffect(() => {
    if (!returnRow) return;
    setReturnRow(consumeRowReturn(returnRow));
  }, [returnRow, listed]);
  // The list is three levels: machine → project → conversation. The pinned
  // bucket is not a place on a machine, so it leads the list on its own.
  const { pinnedBucket, deviceGroups } = useMemo(() => {
    const pinned = listed.find((bucket) => bucket.key === PINNED_BUCKET);
    return {
      pinnedBucket: pinned,
      deviceGroups: groupProjectBucketsByDevice(
        listed.filter((bucket) => bucket.key !== PINNED_BUCKET),
        machines,
        selfDeviceId,
      ),
    };
  }, [listed, machines, selfDeviceId]);
  // Select-all counts what this view can actually select; in the archive view
  // that is the put-away conversations, not the archived projects' live chats.
  const selectableCount = selectableTaskIds(listed, scope).length;
  // A selected id can lose its row while the batch is in flight — another
  // device deleted it, so the delete came back 404 and our own `task_deleted`
  // never arrived. Or it can stop being selectable: a conversation restored
  // from another surface while its project stays archived is still listed,
  // but this view's Restore no longer applies to it. Keeping such an id makes
  // the count and the select-all checkbox describe a row nobody can act on,
  // so the selection follows what the view can actually select.
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const present = new Set(selectableTaskIds(listed, scope));
    const next = Array.from(selectedIds).filter((id) => present.has(id));
    if (next.length !== selectedIds.size) setSelectedIds(new Set(next));
  }, [listed, scope, selectedIds]);

  // Loading is only the first paint. A later fetch keeps the previous rows up
  // (above), so it is not a reason to blank the screen. The archive view reads
  // a second feed, and until that one answers, "nothing archived" would be a
  // claim rather than a state — but only when there is nothing retained to
  // show while it answers; a settled search keeps the old archive on screen.
  const archiveWaiting =
    scope === "archived" &&
    !archivedList.loaded &&
    !archivedList.error &&
    lastLoadedArchivedTasks.current.length === 0;
  const loading = (!taskList.loaded && tasks.length === 0) || machinesLoading || archiveWaiting;
  // One clock for the whole render, so two rows never disagree about "now".
  const now = Date.now();
  // Read once per render, not once per row: `isSessionViewed` re-parses the
  // whole stored map, and this list holds up to a hundred rows on every live
  // update.
  const viewedIds = new Set(getViewedSessionIds());
  const searching = query.trim() !== "";
  // A status or the archived view: the difference between "this library is
  // empty" and "this question has no answer here".
  const filtering = Boolean(status) || scope === "archived";
  // The field is ahead of the request: until the server answers the settled
  // term, an empty list means "not answered yet", not "no matches".
  const pendingQuery = query.trim() !== searchTerm;
  // A failed feed is not an empty one. The archive view reads two, so either
  // one failing on an otherwise empty screen is an error, and a failure with
  // rows already on screen still has to say so — a timeout must never read as
  // "the archive is empty". `listed` is what is actually rendered: the live
  // feed can be non-empty while this view shows nothing at all, so its length
  // is the wrong question to ask.
  const archiveFailed = scope === "archived" && Boolean(archivedList.error);
  const archiveProjectsFailed = scope === "archived" && !archiveFailed && Boolean(taskList.error);
  const loadFailed = (Boolean(taskList.error) || archiveFailed) && listed.length === 0;
  // The pin chip flips its label when the whole selection is already pinned.
  const selectionAllPinned =
    selectedIds.size > 0 && Array.from(selectedIds).every((id) => pinnedIds.has(id));
  const pinLabel = selectionAllPinned ? tr("sessions.unpin") : tr("sessions.pin");
  // Empty copy answers the question that was asked: a filter that matched
  // nothing is not an empty library, a search that matched nothing is not an
  // empty filter, and an archived view with nothing in it is not a failed
  // search for archived chats.
  const emptyView = searching
    ? {
        icon: <IconSessions size={30} />,
        title: tr("sessions.searchEmpty", { query: query.trim() }),
        hint: undefined,
      }
    : scope === "archived"
      ? {
          icon: <IconArchive size={30} />,
          title: tr("sessions.archiveEmpty"),
          hint: tr("sessions.archiveEmptyHint"),
        }
      : filtering
        ? {
            icon: <IconFilter size={30} />,
            title: tr("sessions.filterEmpty"),
            hint: tr("sessions.filterEmptyHint"),
          }
        : {
            icon: <IconSessions size={30} />,
            title: tr("sessions.empty"),
            hint: tr("sessions.emptyHint"),
          };

  function renderBucket(bucket: PhoneProjectBucket, stateKey: string) {
    return (
      <ProjectBucket
        key={stateKey}
        bucket={bucket}
        machines={machines}
        now={now}
        viewedIds={viewedIds}
        // A search result must not hide behind a fold the user set before
        // they typed; the cap folds away for the same reason.
        collapsed={!searching && collapsed.has(stateKey)}
        showAll={searching || expanded.has(stateKey)}
        canToggle={!searching}
        onToggle={() => toggleBucket(stateKey)}
        onToggleShowAll={() => toggleShowAll(stateKey)}
        onOpen={openRow}
        selectionMode={selectionMode}
        selectionLocked={selectionBusy}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelected}
        onLongPress={enterSelection}
        swipeOpen={swipeOpen}
        onSwipeOpenChange={setSwipeOpen}
        pinnedIds={pinnedIds}
        onPin={pinRow}
        onArchive={archiveRow}
        onDelete={deleteRow}
        // Only a heading that stands for an archived project gets the
        // project's Restore. The archive view also lists conversations put
        // away on their own, and their heading is just the project they
        // happen to sit in — a Restore button there would promise to put
        // back something that was never archived and silently do nothing.
        onRestore={
          scope === "archived" && archivedCwdFor(bucket.key, archivedCwds)
            ? () => restoreBucket(bucket)
            : undefined
        }
        onRestoreRow={restoreRow}
        scope={scope}
        query={query}
      />
    );
  }

  function toggleBucket(key: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleShowAll(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function openRow(row: PhoneSessionRow) {
    // Back from this conversation should land on this row, not the top —
    // imported agent sessions are rows in the same list and get the same
    // promise (step 7).
    rememberRowReturn(row.task?.id ?? row.session!.id);
    if (!row.task) {
      navigate(`/agent-sessions/${encodeURIComponent(row.session!.id)}`);
      return;
    }
    // Clearing the dot on the way in is what the sidebar does; without it the
    // same row keeps saying "new" every time the list is reopened.
    if (isTerminal(row.task.status)) markSessionViewed(row.task.id);
    navigate(`/tasks/${encodeURIComponent(row.task.id)}`);
  }

  /** Long-press: enter multi-select with this row selected (the reference's
   *  gesture for batch actions on a touch screen). */
  function enterSelection(row: PhoneSessionRow) {
    // Imported sessions cannot be pinned, archived or restored. In the archive
    // view the one batch action is Restore, so only a conversation that was
    // put away can lead a selection there; a project's live chats are put back
    // with the project's own heading.
    if (!rowSelectable(row, scope)) return;
    setSelectionMode(true);
    setSelectedIds(new Set([row.task!.id]));
    setSwipeOpen(null);
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelectedIds((current) => {
      const all = new Set(selectableTaskIds(listed, scope));
      return current.size === all.size && all.size > 0 ? new Set() : all;
    });
  }

  function exitSelection() {
    selectionEpoch.current += 1;
    setSelectionMode(false);
    setSelectedIds(new Set());
  }

  function pinSelected() {
    const ids = Array.from(selectedIds);
    const allPinned = ids.length > 0 && ids.every((id) => pinnedIds.has(id));
    let next = pinnedIds;
    for (const id of ids) {
      next = new Set(setTaskPinned(id, !allPinned));
    }
    setPinnedIds(next);
    exitSelection();
  }

  /**
   * Move the selection to one side of the archive.
   *
   * Nothing is lost either way, so this asks nothing; a row that fails stays
   * selected so the retry is one tap, and the toast counts what did not go.
   * The daemon publishes each moved row, and the answer is applied here too,
   * so the rest of the batch leaves (or enters) the list the same way a single
   * row does. Archiving and restoring are the same call in opposite
   * directions, and in the archive view the toolbar must offer the direction
   * that view is for.
   */
  async function moveSelected(archived: boolean) {
    if (archivingSelectionRef.current) return;
    archivingSelectionRef.current = true;
    setArchivingSelection(true);
    const epoch = selectionEpoch.current;
    const ids = Array.from(selectedIds);
    try {
      const results = await Promise.allSettled(
        ids.map((id) => (archived ? archiveTask(id) : unarchiveTask(id))),
      );
      const outcome = settleArchiveBatch(ids, results);
      for (const moved of outcome.moved) {
        liveResources.applyMessage({ kind: "task_update", data: moved });
      }
      // The list moved on while this was in flight; its answer is about rows
      // nobody is looking at.
      if (selectionEpoch.current !== epoch) return;
      if (outcome.failed.length > 0) {
        setSelectedIds(new Set(outcome.failed));
        pushToast(
          tr(archived ? "sessions.archiveFailedCount" : "sessions.restoreFailedCount", {
            count: String(outcome.failed.length),
          }),
          "error",
        );
        return;
      }
      exitSelection();
    } finally {
      archivingSelectionRef.current = false;
      setArchivingSelection(false);
    }
  }

  function archiveSelected() {
    void moveSelected(true);
  }

  function restoreSelected() {
    void moveSelected(false);
  }

  function pinRow(row: PhoneSessionRow) {
    if (!row.task) return;
    setPinnedIds(new Set(setTaskPinned(row.task.id, !pinnedIds.has(row.task.id))));
    setSwipeOpen(null);
  }

  /** Put this one conversation away. Undo is the archive view's Restore; the
   *  row leaving the list is the confirmation, so there is no toast for it. */
  async function archiveRow(row: PhoneSessionRow) {
    if (!row.task) return;
    const id = row.task.id;
    setSwipeOpen(null);
    try {
      const archived = await archiveTask(id);
      liveResources.applyMessage({ kind: "task_update", data: archived });
    } catch (err) {
      pushToast(
        err instanceof Error && err.message ? err.message : tr("sessions.archiveFailed"),
        "error",
      );
    }
  }

  /** Put an archived conversation back, from the archive view's row. */
  async function restoreRow(row: PhoneSessionRow) {
    if (!row.task) return;
    const id = row.task.id;
    setSwipeOpen(null);
    try {
      const live = await unarchiveTask(id);
      liveResources.applyMessage({ kind: "task_update", data: live });
    } catch (err) {
      pushToast(
        err instanceof Error && err.message ? err.message : tr("sessions.restoreFailed"),
        "error",
      );
    }
  }

  /** Delete from the row's swipe reveal. The confirm lives in the hook, so
   *  both this and the batch path ask the same question in the same words. */
  async function deleteRow(row: PhoneSessionRow) {
    if (!row.task) return;
    const id = row.task.id;
    setSwipeOpen(null);
    // The bucket's title, not `task.title`: it is the display title the row
    // shows, and a task titled only by its prompt must be named in the
    // confirmation by the same words the person tapped.
    if (await deleteOne({ id, title: row.title })) forgetPins([id]);
  }

  /** Drop deleted ids from the pin preference. A dead id has no visible row,
   *  but it would sit in localStorage forever and read as a pin that exists.
   *  Storage is re-read here: the batch may have outlived a pin the person
   *  made after it started, and this render's `pinnedIds` would not know it. */
  function forgetPins(ids: readonly string[]) {
    const current = new Set(getPinnedTaskIds());
    const pinned = ids.filter((id) => current.has(id));
    if (pinned.length === 0) return;
    let next: ReadonlySet<string> = current;
    for (const id of pinned) next = new Set(setTaskPinned(id, false));
    setPinnedIds(next);
  }

  /**
   * Delete the selection.
   *
   * A declined confirm leaves the selection alone. Rows the daemon refused
   * stay selected — they are still in the list, and a retry should be one tap —
   * and only a batch where everything went exits the mode. A second tap while
   * the requests are in flight is refused: it would confirm again and turn the
   * first batch's success into a round of "not found" errors.
   */
  async function deleteSelected() {
    if (deletingSelectionRef.current) return;
    deletingSelectionRef.current = true;
    setDeletingSelection(true);
    const epoch = selectionEpoch.current;
    const ids = Array.from(selectedIds);
    try {
      const outcome = await deleteMany(ids);
      if (outcome === null) return;
      forgetPins(ids.filter((id) => !outcome.failed.includes(id)));
      // The list moved on while this was in flight (a search or filter change
      // cleared the selection); its answer is about rows nobody is looking at.
      if (selectionEpoch.current !== epoch) return;
      if (outcome.failed.length > 0) {
        setSelectedIds(new Set(outcome.failed));
        return;
      }
      exitSelection();
    } finally {
      deletingSelectionRef.current = false;
      setDeletingSelection(false);
    }
  }

  function changeFilter(next: { status: SessionStatusFilter; scope: SessionScopeFilter }) {
    const nextParams = new URLSearchParams(params);
    if (next.status) nextParams.set("status", next.status);
    else nextParams.delete("status");
    if (next.scope === "archived") nextParams.set("scope", "archived");
    else nextParams.delete("scope");
    setParams(nextParams, { replace: true });
  }

  /** Restore an archived project from the archived view. */
  function restoreBucket(bucket: PhoneProjectBucket) {
    // The stored entry, not the bucket key: bucketing maps the sidebar's
    // no-cwd sentinel onto this module's, and restoring the mapped name would
    // find nothing to remove.
    const cwd = archivedCwdFor(bucket.key, archivedCwds);
    if (cwd) {
      setSwipeOpen(null);
      unarchiveProject(cwd);
    }
  }

  /**
   * Older pages for every feed on screen.
   *
   * Tasks have no cursor, so the oldest loaded id of that feed is the cursor
   * (`?before=` is an exclusive id bound, and the list is id-desc). The
   * archive view has its own feed and its own cursor; the imported sessions
   * have a keyset cursor of their own. A page shorter than the limit is the
   * end.
   */
  async function loadOlder() {
    if (loadingOlder) return;
    // The question this page answers. Both feeds drop their response when the
    // filter or the term has moved on: otherwise a slow page lands under a
    // list it was not asked for, and a stale cursor keeps paging from it.
    const generation = requestGeneration.current;
    setLoadingOlder(true);
    try {
      if (hasMoreTasks) {
        // Each feed pages from its own tail. `liveRows` is the live list and
        // its pages; the archive feed's rows are not bounds in it, and a bound
        // from the wrong feed either repeats a page or skips one.
        const oldest = liveRows[liveRows.length - 1]?.id;
        if (oldest) {
          const page = await listTasks({
            ...sessionListParams(searchTerm, status),
            before: oldest,
          });
          if (requestGeneration.current !== generation) return;
          setOlderTasks((current) => [...current, ...page]);
          setTaskMore(page.length >= taskLimit);
        } else {
          setTaskMore(false);
        }
      }
      if (hasMoreArchive) {
        const oldest = archivedRows[archivedRows.length - 1]?.id;
        if (oldest) {
          const page = await listTasks({
            ...sessionListParams(searchTerm, status, true),
            before: oldest,
          });
          if (requestGeneration.current !== generation) return;
          setOlderArchivedTasks((current) => [...current, ...page]);
          setArchiveMore(page.length >= archiveLimit);
        } else {
          setArchiveMore(false);
        }
      }
      if (hasMoreSessions && sessionCursor) {
        const term = sessionListParams(searchTerm);
        const page = await listAgentSessionsPage({
          limit: term.limit,
          q: term.q,
          before: sessionCursor,
        });
        if (requestGeneration.current !== generation) return;
        setOlderSessions((current) => [...current, ...page.items]);
        setSessionCursor(page.next_cursor);
      }
    } catch {
      // Keep what is on screen and leave the button in place: the next tap
      // asks again rather than the list pretending it reached the end.
    } finally {
      setLoadingOlder(false);
    }
  }

  return (
    <MobileScreen className="mx-auto w-full max-w-2xl">
      {/* The bar is the heading on a phone, and this page deliberately has no
          title there — the rows are the page. `sr-only` keeps a heading in the
          accessibility tree anyway, so screen-reader heading navigation has
          somewhere to land; `md:not-sr-only` brings it back once the bar is
          gone and the page stands on its own. The wrapper carries the spacing
          because `not-sr-only` resets padding. */}
      <div className="md:px-4 md:pt-6">
        <h1 className="sr-only md:not-sr-only md:text-hero md:font-bold md:tracking-tight md:text-kin-text">
          {tr("nav.sessions")}
        </h1>
      </div>
      {/* The phone's field lives in the bar, which is hidden from `md` up;
          without this one a `?q=` link would filter the list with nothing on
          screen to clear it. */}
      <div className="hidden md:block md:px-4 md:pb-1 md:pt-3">
        <SessionsSearch />
      </div>

      {/* Filters sit outside the header bar so the same control works at both
          widths: the phone bar is a different component, and the sheet it
          would open is `md:hidden`. */}
      <SessionFilters status={status} scope={scope} onChange={changeFilter} />

      {loading && (
        <p className="px-4 py-10 text-center text-strong text-kin-muted">
          {tr("sessions.loading")}
        </p>
      )}

      {/* The field is ahead of the request: an empty list right now means "the
          server has not answered this term yet", not "nothing matches". */}
      {!loading && pendingQuery && listed.length === 0 && !loadFailed && (
        <p className="px-4 py-10 text-center text-strong text-kin-muted">
          {tr("sessions.searching")}
        </p>
      )}

      {/* A failed request is not an empty library. The two used to share a
          branch, so a dropped connection read as "you have no chats". */}
      {!loading && loadFailed && (
        <MobileEmpty
          icon={<IconAlert size={30} />}
          title={tr("sessions.loadError")}
          hint={tr("sessions.loadErrorHint")}
        />
      )}

      {!loading && !loadFailed && !(pendingQuery && listed.length === 0) && listed.length === 0 && (
        <MobileEmpty icon={emptyView.icon} title={emptyView.title} hint={emptyView.hint} />
      )}

      {/* Multi-select toolbar, in the slot the heading would occupy: select
          all + count on the left, the batch actions on the right. Long-press
          any row to enter this mode (the reference's gesture); the same
          actions are on each row's swipe reveal, so nothing is touch-only. */}
      {selectionMode && (
        <div className="sticky top-0 z-[3] flex min-h-12 items-center gap-2 border-b border-[var(--kin-hairline)] bg-[var(--kin-page)] px-3 kin-glass">
          <label className="flex min-h-11 items-center gap-2 text-strong font-medium text-kin-text">
            <SelectAllCheckbox
              checked={selectedIds.size > 0 && selectedIds.size === selectableCount}
              partial={selectedIds.size > 0 && selectedIds.size < selectableCount}
              onChange={selectAll}
              label={tr("sessions.selectAll")}
            />
            {tr("sessions.selectedCount", { count: String(selectedIds.size) })}
          </label>
          <div className="ml-auto flex items-center gap-1.5">
            {/* Three batch actions and a cancel no longer fit a 390px bar
                with labels; below `sm` the chips are icon-only and the label
                becomes their accessible name. Colour alone never carries the
                delete: it is a trash icon and it says "Delete". */}
            {/* Pin is the live list's own ordering; the archived view does not
                put pins on a heading, so the chip would reorder a list that
                never shows a pinned bucket. */}
            {scope !== "archived" && (
              <button
                type="button"
                onClick={pinSelected}
                disabled={selectedIds.size === 0 || selectionBusy}
                aria-label={pinLabel}
                title={pinLabel}
                className="flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--kin-fill)] px-2.5 text-body font-medium text-kin-text disabled:opacity-40 sm:px-3"
              >
                <IconPin size={14} />
                <span className="hidden sm:inline">{pinLabel}</span>
              </button>
            )}
            {/* The archive view's batch offers the direction that view is for:
                a selection there is archived already, so archiving it again
                would only re-stamp the date and change nothing. */}
            <button
              type="button"
              onClick={scope === "archived" ? restoreSelected : archiveSelected}
              disabled={selectedIds.size === 0 || selectionBusy}
              aria-label={tr(scope === "archived" ? "sessions.restore" : "sessions.archive")}
              title={tr(scope === "archived" ? "sessions.restore" : "sessions.archive")}
              className="flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--kin-fill)] px-2.5 text-body font-medium text-kin-text disabled:opacity-40 sm:px-3"
            >
              {scope === "archived" ? <IconRestore size={14} /> : <IconArchive size={14} />}
              <span className="hidden sm:inline">
                {tr(scope === "archived" ? "sessions.restore" : "sessions.archive")}
              </span>
            </button>
            <button
              type="button"
              onClick={deleteSelected}
              disabled={selectedIds.size === 0 || selectionBusy}
              aria-label={
                deletingSelection ? tr("sessions.deletingSelected") : tr("sessions.delete")
              }
              title={deletingSelection ? tr("sessions.deletingSelected") : tr("sessions.delete")}
              aria-busy={deletingSelection || undefined}
              className="flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg bg-kin-red/15 px-2.5 text-body font-medium text-kin-red-ink disabled:opacity-40 sm:px-3"
            >
              <IconTrash size={14} />
              <span className="hidden sm:inline">
                {deletingSelection ? tr("sessions.deletingSelected") : tr("sessions.delete")}
              </span>
            </button>
            <button
              type="button"
              onClick={exitSelection}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-lg px-2.5 text-body font-medium text-kin-muted hover:text-kin-text sm:px-3"
            >
              {tr("common.cancel")}
            </button>
          </div>
        </div>
      )}

      {!loading && pinnedBucket && renderBucket(pinnedBucket, pinnedBucket.key)}

      {!loading &&
        deviceGroups.map((group) => {
          const label = group.isSelf ? tr("nav.thisMachine") : group.label;
          return (
            <section key={group.id || "__self__"} aria-label={label}>
              {/* The machine is the top level, and it is always named — one
                  machine is still a machine, not a list with no owner. */}
              <div className="flex items-center gap-1.5 px-4 pb-0.5 pt-3">
                <IconMachine size={14} className="flex-none text-kin-muted" />
                <h2 className="min-w-0 flex-1 truncate text-caption font-semibold uppercase tracking-label text-kin-muted">
                  {label}
                </h2>
                <span className="flex-none text-caption tabular-nums text-kin-muted">
                  {group.count}
                </span>
              </div>
              {group.buckets.map((bucket) =>
                // The same project can run on two machines; the device is part
                // of the fold's identity so collapsing one leaves the other
                // where it was.
                renderBucket(bucket, `${group.id}::${bucket.key}`),
              )}
            </section>
          );
        })}

      {/* Older rows are a choice, not an infinite scroll: the list is a place
          people scan, and a viewport that keeps growing under the thumb loses
          the row that was being read. */}
      {!loading && (hasMoreTasks || hasMoreArchive || hasMoreSessions) && (
        <button
          type="button"
          onClick={loadOlder}
          disabled={loadingOlder}
          className="kin-row-press flex min-h-11 w-full items-center justify-center px-4 py-2 text-body font-medium text-kin-muted disabled:opacity-60"
        >
          {loadingOlder ? tr("sessions.loadingOlder") : tr("sessions.loadOlder")}
        </button>
      )}

      {/* One archive feed failed but the other answered: the rows on screen
          are real, the rest are missing, and silence would read as "there are
          none". Told apart because the fix differs — one side is the archive
          itself, the other the archived projects' chats. */}
      {!loading && (archiveFailed || archiveProjectsFailed) && listed.length > 0 && (
        <p className="px-4 py-6 text-center text-body text-kin-muted">
          {tr(archiveFailed ? "sessions.archiveLoadFailed" : "sessions.archiveProjectsLoadFailed")}
        </p>
      )}

      {!loading && !status && sessionsFailed && buckets.length > 0 && (
        <p className="px-4 py-6 text-center text-body text-kin-muted">
          {tr("sessions.agentSessionsFailed")}
        </p>
      )}

      {/* The dock's FAB floats over this list's tail (the reference keeps it
          above the dock, and the list reserves that much height): without
          this spacer the last row's relative time lands under the pencil. */}
      <div className="h-60" aria-hidden />
    </MobileScreen>
  );
}

/** The select-all control. `indeterminate` is not a React prop, so the DOM
 *  node's own property is synced after each render: a half-selected list
 *  reads as neither checked nor empty. */
function SelectAllCheckbox({
  checked,
  partial,
  onChange,
  label,
}: {
  checked: boolean;
  partial: boolean;
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partial;
  }, [partial]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className="h-5 w-5 accent-kin-blue"
      aria-label={label}
    />
  );
}

function ProjectBucket({
  bucket,
  machines,
  now,
  viewedIds,
  collapsed,
  showAll,
  canToggle,
  onToggle,
  onToggleShowAll,
  onOpen,
  selectionMode,
  selectionLocked,
  selectedIds,
  onToggleSelect,
  onLongPress,
  swipeOpen,
  onSwipeOpenChange,
  pinnedIds,
  onPin,
  onArchive,
  onDelete,
  onRestore,
  onRestoreRow,
  scope,
  query,
}: {
  bucket: PhoneProjectBucket;
  /** Where a pinned remote row gets its machine's name from; every other row
   *  is already under that machine's heading. */
  machines: readonly Machine[];
  /** The live search text, marked in the heading and in every row title. */
  query: string;
  now: number;
  viewedIds: ReadonlySet<string>;
  collapsed: boolean;
  showAll: boolean;
  /** False while searching: the list is already showing every match, so a
   *  "show less" control would be a button that does nothing. */
  canToggle: boolean;
  onToggle: () => void;
  onToggleShowAll: () => void;
  onOpen: (row: PhoneSessionRow) => void;
  selectionMode: boolean;
  /** A batch is deleting: a tap must not change the selection it captured. */
  selectionLocked: boolean;
  selectedIds: ReadonlySet<string>;
  onToggleSelect: (key: string) => void;
  onLongPress: (row: PhoneSessionRow) => void;
  swipeOpen: string | null;
  onSwipeOpenChange: (open: string | null) => void;
  /** The page's pin preference, so a pinned row's chip says "Unpin". */
  pinnedIds: ReadonlySet<string>;
  onPin: (row: PhoneSessionRow) => void;
  onArchive: (row: PhoneSessionRow) => void;
  onDelete: (row: PhoneSessionRow) => void;
  /** Present only in the archived view: put this project back in the list. */
  onRestore?: () => void;
  /** Present only in the archived view: put this conversation back. */
  onRestoreRow: (row: PhoneSessionRow) => void;
  scope: SessionScopeFilter;
}) {
  const tr = useT();
  const rows = showAll ? bucket.rows : bucket.rows.slice(0, ROWS_BEFORE_SHOW_ALL);
  const hidden = bucket.rows.length - rows.length;

  return (
    <section className="pb-1">
      <div className="flex items-center gap-1.5 px-4 pb-1 pt-4">
        <button
          type="button"
          onClick={() => {
            // While searching every bucket is force-opened, so a fold made here
            // would be invisible until the query was cleared — a click that looks
            // like it did nothing and then silently hides rows.
            if (canToggle) onToggle();
          }}
          aria-expanded={!collapsed}
          // The visible label carries a `<mark>` while searching; the accessible
          // name must stay the plain project name, not "Kin, highlighted, …".
          aria-label={bucket.label}
          className="kin-row-press flex min-h-11 min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {collapsed ? (
            <IconFolder size={20} className="flex-none text-kin-muted" strokeWidth={1.75} />
          ) : (
            <IconFolderOpen size={20} className="flex-none text-kin-muted" strokeWidth={1.75} />
          )}
          {/* Label and chevron share a tight cluster, the chevron immediately
              after the text — a chevron pinned to the far edge would sit in the
              same column as the rows' timestamps and read as one of them. */}
          <span className="flex min-w-0 max-w-full items-center gap-1">
            <span className="min-w-0 truncate text-strong font-semibold text-kin-muted">
              <HighlightedText text={bucket.label} query={query} />
            </span>
            <IconChevronDown
              size={14}
              strokeWidth={2.25}
              className={[
                "flex-none text-kin-muted transition-transform duration-150",
                collapsed ? "-rotate-90" : "",
              ].join(" ")}
            />
          </span>
        </button>
        {onRestore && (
          <button
            type="button"
            onClick={onRestore}
            // Three archived projects would otherwise be three buttons called
            // "Restore": the view's only action has to say which project it
            // acts on.
            aria-label={`${tr("sessions.restore")} ${bucket.label}`}
            className="flex min-h-9 flex-none items-center gap-1.5 rounded-lg bg-[var(--kin-fill)] px-2.5 text-caption font-medium text-kin-text"
          >
            <IconRefresh size={13} />
            {tr("sessions.restore")}
          </button>
        )}
      </div>

      {!collapsed && (
        <>
          {rows.map((row) => (
            <SessionRow
              key={row.key}
              row={row}
              deviceLabel={pinnedRowDeviceName(bucket.key, row, machines)}
              now={now}
              viewedIds={viewedIds}
              onOpen={() => onOpen(row)}
              selectionMode={selectionMode}
              selectionLocked={selectionLocked}
              selected={row.task ? selectedIds.has(row.task.id) : false}
              onToggleSelect={() => onToggleSelect(row.key)}
              onLongPress={() => onLongPress(row)}
              swipeOpen={swipeOpen === row.key}
              onSwipeOpenChange={(open) => onSwipeOpenChange(open ? row.key : null)}
              pinned={row.task ? pinnedIds.has(row.task.id) : false}
              onPin={() => onPin(row)}
              onArchive={() => onArchive(row)}
              onDelete={() => onDelete(row)}
              onRestore={() => onRestoreRow(row)}
              scope={scope}
              query={query}
            />
          ))}
          {canToggle && (hidden > 0 || bucket.rows.length > ROWS_BEFORE_SHOW_ALL) ? (
            <button
              type="button"
              onClick={onToggleShowAll}
              aria-expanded={showAll}
              className="kin-row-press flex min-h-11 w-full items-center gap-2.5 px-4 text-left text-body font-medium text-kin-muted"
            >
              {/* The status column's width, left empty: the label starts on the
                  avatar column so the toggle reads as this list's tail rather
                  than as another section heading. */}
              <span className="w-2 flex-none" aria-hidden />
              <span className="min-w-0 truncate">
                {hidden > 0
                  ? tr("sessions.showAll", { count: String(bucket.rows.length) })
                  : tr("sessions.showLess")}
              </span>
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}

function SessionRow({
  row,
  deviceLabel,
  now,
  viewedIds,
  onOpen,
  selectionMode,
  selectionLocked,
  selected,
  onToggleSelect,
  onLongPress,
  swipeOpen,
  onSwipeOpenChange,
  pinned,
  onPin,
  onArchive,
  onDelete,
  onRestore,
  scope,
  query,
}: {
  row: PhoneSessionRow;
  /** The machine's name, when no heading above the row carries it. */
  deviceLabel: string;
  /** The live search text, marked in the title. */
  query: string;
  now: number;
  viewedIds: ReadonlySet<string>;
  onOpen: () => void;
  selectionMode: boolean;
  selectionLocked: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onLongPress: () => void;
  swipeOpen: boolean;
  onSwipeOpenChange: (open: boolean) => void;
  /** This row is in the pinned bucket: its pin chip unpins. */
  pinned: boolean;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
  /** Put this one conversation back; only archived rows carry it. */
  onRestore: () => void;
  /** Which list this row is drawn in: it decides which strip it uncovers. */
  scope: SessionScopeFilter;
}) {
  const tr = useT();
  // The sidebar's dot, on the phone: green means a run finished and has not
  // been opened, blue means it is still going. Null (nothing drawn) is the
  // common case, so the list is not a field of dots.
  const dot = row.task ? sessionStatusDotClass(row.task.status, viewedIds.has(row.task.id)) : null;
  const avatar = agentAvatarMeta(row.agentId);
  // The row's name is what a screen reader reads, so it has to carry the state
  // the dot encodes: the dot itself is aria-hidden decoration in three colours,
  // and a name that omitted it would tell a different story from the one the
  // dots and columns tell everyone else.
  const label = [
    row.title,
    agentDisplayName(row.agentId),
    formatRelativeTime(row.at, now),
    row.task && dot ? tr(taskCardStatusView(row.task.status).labelKey) : "",
    row.remote ? deviceLabel || tr("machine.remote") : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const rowButton = (
    <button
      type="button"
      data-session-row={row.task?.id ?? row.session?.id}
      onClick={() => {
        if (selectionMode) {
          // Imported agent sessions have no task id and no batch actions;
          // neither has a live chat in the archive view, whose batch restores.
          // A batch in flight owns the selection it captured, so taps wait for
          // it to land.
          if (rowSelectable(row, scope) && !selectionLocked) onToggleSelect();
          return;
        }
        // A tap on a swipe-revealed row closes the reveal instead of opening
        // the session — the actions were the reason the row moved.
        if (swipeOpen) {
          onSwipeOpenChange(false);
          return;
        }
        onOpen();
      }}
      onKeyDown={(event) => {
        // Keyboard entry to the multi-select: Shift+Enter toggles this row
        // (the equivalent of a long press, which a keyboard cannot do).
        if (event.key === "Enter" && event.shiftKey) {
          event.preventDefault();
          if (rowSelectable(row, scope) && !selectionLocked) onToggleSelect();
        }
      }}
      aria-disabled={selectionMode && selectionLocked ? true : undefined}
      aria-label={label}
      aria-pressed={selectionMode ? selected : undefined}
      className={[
        "kin-row-press flex min-h-11 w-full items-center gap-2.5 px-4 py-2.5 text-left",
        selectionMode && selected ? "bg-[var(--kin-fill)]" : "",
      ].join(" ")}
    >
      <span className="flex w-2 flex-none justify-center">
        {selectionMode && rowSelectable(row, scope) ? (
          <span
            className={[
              "flex h-4 w-4 items-center justify-center rounded-full border",
              selected
                ? "border-kin-blue bg-kin-blue text-kin-on-brand"
                : "border-[var(--kin-hairline-strong)]",
            ].join(" ")}
            aria-hidden
          >
            {selected ? <IconCheck size={10} strokeWidth={2.5} /> : null}
          </span>
        ) : dot ? (
          <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden />
        ) : null}
      </span>
      <span
        className={`flex h-5 w-5 flex-none items-center justify-center rounded-full text-micro font-semibold ${avatar.className}`}
        title={agentDisplayName(row.agentId)}
      >
        {avatar.initials}
      </span>
      <span className="min-w-0 flex-1 truncate text-subtitle font-medium leading-ui text-kin-text">
        <HighlightedText text={row.title} query={query} />
      </span>
      {row.remote && (
        <span
          className="flex-none text-kin-muted"
          title={deviceLabel || tr("machine.remote")}
          aria-hidden
        >
          <IconMachine size={12} />
        </span>
      )}
      {deviceLabel ? (
        // The pinned section has no machine heading above it, so the row says
        // the machine itself. Truncated rather than wrapped: a long machine
        // name must not push the time out of the row.
        <span className="max-w-[6rem] flex-none truncate text-caption leading-ui text-kin-muted">
          {deviceLabel}
        </span>
      ) : null}
      <span className="flex-none text-caption leading-ui text-kin-muted tabular-nums">
        {formatRelativeTime(row.at, now)}
      </span>
    </button>
  );

  // A row uncovers the strip that describes where it is. In the archive view
  // that is restore + delete, and only for a conversation that was archived on
  // its own: a live chat listed under an archived project is put back by the
  // project's own Restore, and a per-row "Restore" there would do nothing.
  if (selectionMode || !row.task) return rowButton;
  const mode: SessionRowActionMode | null = row.task.archived_at
    ? "archived"
    : scope === "archived"
      ? null
      : "active";
  if (!mode) return rowButton;

  // Swipe left to reveal the same batch actions the multi-select owns, plus
  // the delete only the list offers (a session can be deleted from inside it,
  // but the list is where old ones are scanned and discarded). The long-press
  // that enters multi-select lives in the swipe wrapper too: once a drag
  // captures the pointer, the row's own button stops seeing moves, and a timer
  // it can no longer cancel would fire behind the user's back (or the cancel
  // would never fire at all).
  return (
    <SwipeReveal
      open={swipeOpen}
      onOpenChange={onSwipeOpenChange}
      onLongPress={onLongPress}
      width={sessionRowActionsWidth(mode)}
      actions={
        <SessionRowActions
          mode={mode}
          pinned={pinned}
          onPin={onPin}
          onArchive={onArchive}
          onRestore={onRestore}
          onDelete={onDelete}
        />
      }
    >
      {rowButton}
    </SwipeReveal>
  );
}
