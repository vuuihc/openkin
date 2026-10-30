import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  isTerminal,
  listAgentSessionsPage,
  listTasks,
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
  phoneProjectBuckets,
  withPinnedBucket,
  type PhoneProjectBucket,
  type PhoneSessionRow,
} from "../lib/phoneSessionBuckets";
import { getPinnedTaskIds, setTaskPinned } from "../lib/taskPins";
import { sessionListParams } from "../lib/sessionListParams";
import {
  getViewedSessionIds,
  markSessionViewed,
  sessionStatusDotClass,
} from "../lib/sessionViewed";
import { taskCardStatusView } from "../lib/taskCardStatus";
import { mergeTaskTail } from "../lib/taskTail";
import {
  archiveProject,
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
  IconSessions,
  IconTrash,
} from "../components/icons";
import SwipeReveal from "../components/mobile/SwipeReveal";
import SessionRowActions, {
  SESSION_ROW_ACTIONS_WIDTH,
} from "../components/mobile/SessionRowActions";
import { useSessionDeletion } from "../hooks/useSessionDeletion";

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
  const [olderSessions, setOlderSessions] = useState<AgentSession[]>([]);
  // The imported-sessions feed answers with a keyset cursor; the tasks feed
  // has none, so "is there more" is inferred from a full page (`null` = not
  // asked yet).
  const [sessionCursor, setSessionCursor] = useState<string | undefined>(undefined);
  const [taskMore, setTaskMore] = useState<boolean | null>(null);
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
  // The archived view has no batch actions. A selection made before switching
  // would leave its toolbar over a list whose buttons are no-ops.
  useEffect(() => {
    if (scope !== "archived") return;
    selectionEpoch.current += 1;
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, [scope]);

  // A different question is a different list. A selection made under the old
  // one would let Delete remove rows the person can no longer see — "select
  // all, then search, then Delete" would arm exactly that.
  useEffect(() => {
    selectionEpoch.current += 1;
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, [query, status]);

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
    setTaskMore(null);
  }, [searchTerm, status]);

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
  // The live list first, then the older pages a person asked for. The merge
  // asks the live store about each tail id — a row deleted since its page was
  // fetched disappears instead of navigating to a 404, and one that changed
  // status is shown as it is now rather than as it was. Deduped by id: a row
  // can arrive through both feeds.
  //
  // The status filter is applied here as well as on the server. A filter
  // change is a new live-list key, and the hook hands back an unloaded
  // resource until it answers; without local narrowing the previous filter's
  // rows would sit under the new chip for a whole round trip, which over the
  // relay is seconds, not milliseconds.
  const tasks = useMemo(() => {
    const merged = mergeTaskTail(liveTasks, olderTasks, (id) => liveResources.taskSnapshot(id));
    return status ? merged.filter((task) => task.status === status) : merged;
  }, [liveTasks, olderTasks, status]);
  const allSessions = useMemo(() => {
    if (olderSessions.length === 0) return sessions;
    const seen = new Set(sessions.map((session) => session.id));
    return [...sessions, ...olderSessions.filter((session) => !seen.has(session.id))];
  }, [sessions, olderSessions]);
  const taskLimit = sessionListParams(searchTerm, status).limit;
  const hasMoreTasks = taskMore ?? (taskList.loaded && tasks.length >= taskLimit);
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
  // A selected id can lose its row while the batch is in flight — another
  // device deleted it, so the delete came back 404 and our own `task_deleted`
  // never arrived. Keeping it selected makes the count and the select-all
  // checkbox describe a row nobody can see, so the selection follows the list.
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const present = new Set(
      listed.flatMap((bucket) =>
        bucket.rows.filter((row) => row.task).map((row) => row.task!.id),
      ),
    );
    const next = Array.from(selectedIds).filter((id) => present.has(id));
    if (next.length !== selectedIds.size) setSelectedIds(new Set(next));
  }, [listed, selectedIds]);

  // Loading is only the first paint. A later fetch keeps the previous rows up
  // (above), so it is not a reason to blank the screen.
  const loading = (!taskList.loaded && tasks.length === 0) || machinesLoading;
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
  const loadFailed = Boolean(taskList.error) && tasks.length === 0;
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
    // Imported sessions cannot be pinned or archived; the archived view's
    // batch actions would be "archive what is already archived".
    if (!row.task || scope === "archived") return;
    setSelectionMode(true);
    setSelectedIds(new Set([row.task.id]));
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
      const all = new Set(
        listed.flatMap((bucket) =>
          bucket.rows.filter((row) => row.task).map((row) => row.key),
        ),
      );
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

  function archiveSelected() {
    const cwds = new Set<string>();
    for (const bucket of listed) {
      for (const row of bucket.rows) {
        if (row.task && selectedIds.has(row.task.id)) cwds.add(row.task.cwd);
      }
    }
    for (const cwd of cwds) archiveProject(cwd);
    exitSelection();
  }

  function pinRow(row: PhoneSessionRow) {
    if (!row.task) return;
    setPinnedIds(new Set(setTaskPinned(row.task.id, !pinnedIds.has(row.task.id))));
    setSwipeOpen(null);
  }

  function archiveRow(row: PhoneSessionRow) {
    if (!row.task) return;
    archiveProject(row.task.cwd);
    setSwipeOpen(null);
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
   * Older pages for both feeds.
   *
   * Tasks have no cursor, so the oldest loaded id is the cursor (`?before=`
   * is an exclusive id bound, and the list is id-desc). The imported feed has
   * a keyset cursor of its own. A page shorter than the limit is the end.
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
        const oldest = tasks[tasks.length - 1]?.id;
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

      {!loading &&
        !loadFailed &&
        !(pendingQuery && listed.length === 0) &&
        listed.length === 0 && (
          <MobileEmpty
            icon={emptyView.icon}
            title={emptyView.title}
            hint={emptyView.hint}
          />
        )}

      {/* Multi-select toolbar, in the slot the heading would occupy: select
          all + count on the left, the batch actions on the right. Long-press
          any row to enter this mode (the reference's gesture); the same
          actions are on each row's swipe reveal, so nothing is touch-only. */}
      {selectionMode && (
        <div className="sticky top-0 z-[3] flex min-h-12 items-center gap-2 border-b border-[var(--kin-hairline)] bg-[var(--kin-page)] px-3 kin-glass">
          <label className="flex min-h-11 items-center gap-2 text-strong font-medium text-kin-text">
            <SelectAllCheckbox
              checked={selectedIds.size > 0 && selectedIds.size === taskRowCount(listed)}
              partial={selectedIds.size > 0 && selectedIds.size < taskRowCount(listed)}
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
            <button
              type="button"
              onClick={pinSelected}
              disabled={selectedIds.size === 0 || deletingSelection}
              aria-label={pinLabel}
              title={pinLabel}
              className="flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--kin-fill)] px-2.5 text-body font-medium text-kin-text disabled:opacity-40 sm:px-3"
            >
              <IconPin size={14} />
              <span className="hidden sm:inline">{pinLabel}</span>
            </button>
            <button
              type="button"
              onClick={archiveSelected}
              disabled={selectedIds.size === 0 || deletingSelection}
              aria-label={tr("sessions.archive")}
              title={tr("sessions.archive")}
              className="flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg bg-[var(--kin-fill)] px-2.5 text-body font-medium text-kin-text disabled:opacity-40 sm:px-3"
            >
              <IconArchive size={14} />
              <span className="hidden sm:inline">{tr("sessions.archive")}</span>
            </button>
            <button
              type="button"
              onClick={deleteSelected}
              disabled={selectedIds.size === 0 || deletingSelection}
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

      {!loading &&
        listed.map((bucket) => (
          <ProjectBucket
            key={bucket.key}
            bucket={bucket}
            now={now}
            viewedIds={viewedIds}
            // A search result must not hide behind a fold the user set before
            // they typed; the cap folds away for the same reason.
            collapsed={!searching && collapsed.has(bucket.key)}
            showAll={searching || expanded.has(bucket.key)}
            canToggle={!searching}
            onToggle={() => toggleBucket(bucket.key)}
            onToggleShowAll={() => toggleShowAll(bucket.key)}
            onOpen={openRow}
            selectionMode={selectionMode}
            selectionLocked={deletingSelection}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelected}
            onLongPress={enterSelection}
            swipeOpen={swipeOpen}
            onSwipeOpenChange={setSwipeOpen}
            pinnedIds={pinnedIds}
            onPin={pinRow}
            onArchive={archiveRow}
            onDelete={deleteRow}
            onRestore={scope === "archived" ? () => restoreBucket(bucket) : undefined}
            actionsEnabled={scope !== "archived"}
            query={query}
          />
        ))}

      {/* Older rows are a choice, not an infinite scroll: the list is a place
          people scan, and a viewport that keeps growing under the thumb loses
          the row that was being read. */}
      {!loading && (hasMoreTasks || hasMoreSessions) && (
        <button
          type="button"
          onClick={loadOlder}
          disabled={loadingOlder}
          className="kin-row-press flex min-h-11 w-full items-center justify-center px-4 py-2 text-body font-medium text-kin-muted disabled:opacity-60"
        >
          {loadingOlder ? tr("sessions.loadingOlder") : tr("sessions.loadOlder")}
        </button>
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

/** The rows a select-all can actually select: tasks only. */
function taskRowCount(buckets: PhoneProjectBucket[]): number {
  return buckets.reduce((sum, bucket) => sum + bucket.rows.filter((row) => row.task).length, 0);
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
  actionsEnabled,
  query,
}: {
  bucket: PhoneProjectBucket;
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
  /** Rows reveal pin/archive/delete on a swipe; the archived view has none. */
  actionsEnabled: boolean;
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
              actionsEnabled={actionsEnabled}
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
  actionsEnabled,
  query,
}: {
  row: PhoneSessionRow;
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
  /** False in the archived view, where pin and archive would be no-ops. */
  actionsEnabled: boolean;
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
    row.remote ? tr("machine.remote") : "",
  ]
    .filter(Boolean)
    .join(" · ");

  const rowButton = (
    <button
      type="button"
      onClick={() => {
        if (selectionMode) {
          // Imported agent sessions have no task id and no batch actions;
          // they are not selectable. A batch in flight owns the selection it
          // captured, so taps wait for it to land.
          if (row.task && !selectionLocked) onToggleSelect();
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
          if (row.task && !selectionLocked) onToggleSelect();
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
        {selectionMode ? (
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
        <span className="flex-none text-kin-muted" title={tr("machine.remote")} aria-hidden>
          <IconMachine size={12} />
        </span>
      )}
      <span className="flex-none text-caption leading-ui text-kin-muted tabular-nums">
        {formatRelativeTime(row.at, now)}
      </span>
    </button>
  );

  // The archived view shows what is already archived: a "Archive" action there
  // would be a no-op and a "Pin" would move a row into a list it is not in.
  if (selectionMode || !row.task || !actionsEnabled) return rowButton;

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
      width={SESSION_ROW_ACTIONS_WIDTH}
      actions={
        <SessionRowActions
          pinned={pinned}
          onPin={onPin}
          onArchive={onArchive}
          onDelete={onDelete}
        />
      }
    >
      {rowButton}
    </SwipeReveal>
  );
}
