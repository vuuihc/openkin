import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  archiveTask,
  ensureProject,
  isTerminal,
  listAgentSessionsPage,
  listProjects,
  listTasks,
  unarchiveTask,
  type AgentSession,
  type Project,
  type Task,
} from "../../api/client";
import { liveResources } from "../../api/liveResources";
import { usePendingResources, useTaskList } from "../../api/useLiveResources";
import { useSessionDeletion } from "../../hooks/useSessionDeletion";
import { useCoarsePointer } from "../../hooks/useMediaQuery";
import { useMachines } from "../../hooks/useMachines";
import { useLocale, useT } from "../../i18n/react";
import { settleArchiveBatch } from "../../lib/archiveBatch";
import type { Machine } from "../../lib/devices";
import { runGuardedNavigation } from "../../lib/leaveGuard";
import { draftEntryState, listUrlFor, phonePush } from "../../lib/phoneNavigation";
import {
  DRAFT_PATH,
  getDraftCwd,
  getDraftPrompt,
  setDraftCwd,
  setDraftMachine,
  subscribeDraft,
} from "../../lib/draftChat";
import { isImeKeyEvent } from "../../lib/ime";
import { pendingCountsByTask } from "../../lib/pendingCounts";
import {
  archivedCwdFor,
  bucketKeyFor,
  filterProjectBuckets,
  groupProjectBucketsByDevice,
  isBucketCollapsed,
  isImportedBucket,
  phoneProjectBuckets,
  PINNED_BUCKET,
  pinnedRowDeviceName,
  UNASSIGNED_PROJECT,
  withPinnedBucket,
  type PhoneDeviceGroup,
  type PhoneProjectBucket,
  type PhoneSessionRow,
} from "../../lib/phoneSessionBuckets";
import {
  archiveProject,
  getArchivedProjects,
  getPinnedProjects,
  getProjectLastInteracted,
  getProjectSortMode,
  setProjectSortMode,
  subscribeProjectSidebar,
  toggleProjectPinned,
  touchProject,
  touchSession,
  unarchiveProject,
} from "../../lib/projectSidebar";
import { consumeRowReturn, rememberRowReturn, takeRowReturn } from "../../lib/rowReturn";
import { sortSessionBuckets } from "../../lib/sessionBucketOrder";
import { sessionFeedTasks } from "../../lib/sessionFeed";
import { readSessionFolds, setSessionFold } from "../../lib/sessionFolds";
import { sessionListParams } from "../../lib/sessionListParams";
import { rowSelectable, selectableTaskIds } from "../../lib/sessionSelection";
import {
  getViewedSessionIds,
  markSessionViewed,
  subscribeSessionViewed,
} from "../../lib/sessionViewed";
import { getPinnedTaskIds, setTaskPinned } from "../../lib/taskPins";
import {
  clearBucketOrder,
  getTaskOrder,
  setBucketOrder,
  type TaskOrder,
} from "../../lib/taskOrder";
import { mergeTaskTail } from "../../lib/taskTail";
import ActionSheet from "../ui/ActionSheet";
import Button from "../ui/Button";
import HighlightedText from "../HighlightedText";
import {
  IconAlert,
  IconArchive,
  IconChevronDown,
  IconFile,
  IconFilter,
  IconFolder,
  IconFolderOpen,
  IconMachine,
  IconMore,
  IconPin,
  IconPlus,
  IconRefresh,
  IconSessions,
} from "../icons";
import { MobileEmpty, MobileScreen } from "../mobile/MobileList";
import {
  normalizeScopeFilter,
  normalizeStatusFilter,
  type SessionScopeFilter,
  type SessionStatusFilter,
} from "../ui/SessionFilters";
import { useAppStore } from "../../store/appStore";
import SessionRow from "./SessionRow";
import SessionToolbar, { SessionSelectionBar } from "./SessionToolbar";

/**
 * The one conversation list.
 *
 * R0b-2d merged the phone page and the Mac sidebar into this component: one
 * model (`phoneProjectBuckets`), one row, one set of search / filter / row
 * actions. `shell` decides only the container and which shortcut uncovers a
 * row's overflow — hover controls in the sidebar, swipe and a long press that
 * open the same row menu on the page — never which features the list has.
 *
 * The query, status and scope live in the URL (`?search=`, `?status=`, `?scope=`),
 * so switching width cannot change what the list is showing: the route stays
 * put and both shells read the same parameters. Project order is the existing
 * sidebar preference, which is why it appears in both shells' filter panel.
 */
const LIST_STATE_KEYS = ["search", "status", "scope"] as const;

/**
 * Carry the list's own params through a navigation.
 *
 * The sidebar stays mounted while the main pane changes and reads its search
 * and filters from the current route; a bare pathname would clear them on
 * every row or project tap. Only the list's three keys move: `q` is the
 * composer's prefill and `find` the transcript's find seed, both of which
 * belong to the page being left.
 */
function listStateQuery(params: URLSearchParams, extra: Record<string, string> = {}): string {
  const next = new URLSearchParams();
  for (const key of LIST_STATE_KEYS) {
    const value = params.get(key);
    if (value) next.set(key, value);
  }
  for (const [key, value] of Object.entries(extra)) next.set(key, value);
  const text = next.toString();
  return text ? `?${text}` : "";
}

const ROWS_BEFORE_SHOW_ALL = 5;
const EMPTY_IDS: ReadonlySet<string> = new Set();
const SEARCH_DEBOUNCE_MS = 200;

export default function SessionList({
  shell,
  activeTaskId = null,
}: {
  /** The container: a full page or a sidebar column. Not a feature switch. */
  shell: "sidebar" | "page";
  /** The conversation currently open, marked in the list. */
  activeTaskId?: string | null;
}) {
  const tr = useT();
  const { locale } = useLocale();
  const pushToast = useAppStore((s) => s.pushToast);
  const reconnectGen = useAppStore((s) => s.reconnectGen);
  const { deleteOne, deleteMany } = useSessionDeletion();
  const navigate = useNavigate();
  const location = useLocation();
  const coarse = useCoarsePointer();
  const [params, setParams] = useSearchParams();
  const query = params.get("search") ?? "";
  const status = normalizeStatusFilter(params.get("status"));
  const scope = normalizeScopeFilter(params.get("scope"));

  const [searchTerm, setSearchTerm] = useState(() => query.trim());
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
  const pending = usePendingResources();
  const pendingByTask = useMemo(() => pendingCountsByTask(pending.data), [pending.data]);
  const { machines, loading: machinesLoading } = useMachines();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [olderTasks, setOlderTasks] = useState<Task[]>([]);
  const [olderArchivedTasks, setOlderArchivedTasks] = useState<Task[]>([]);
  const [olderSessions, setOlderSessions] = useState<AgentSession[]>([]);
  const [sessionCursor, setSessionCursor] = useState<string | undefined>(undefined);
  // The cursor the next older page must be read from. A first-page refresh
  // clears it before the answer arrives, and a page that resolves afterwards
  // checks it again: the state the button was rendered from may name a list
  // that no longer exists.
  const sessionCursorRef = useRef<string | undefined>(undefined);
  const [taskMore, setTaskMore] = useState<boolean | null>(null);
  const [archiveMore, setArchiveMore] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sessionsFailed, setSessionsFailed] = useState(false);
  const [sessionReload, setSessionReload] = useState(0);
  const requestGeneration = useRef(0);
  // A first-page read is replacing the list. While it is out its cursor is not
  // offered to "Load older", and its own answer decides whether the rows are
  // replaced; only the newest read may say the wait is over.
  const firstPageInFlight = useRef<number | null>(null);
  const firstPageSeq = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
  // Identifies the newest older-page read. A refresh bumps it, so an older
  // request that never answers cannot leave the control disabled.
  const olderToken = useRef(0);
  const [foldTick, setFoldTick] = useState(0);
  const folds = useMemo(() => readSessionFolds(), [foldTick]);
  const [viewTick, setViewTick] = useState(0);
  useEffect(() => subscribeSessionViewed(() => setViewTick((n) => n + 1)), []);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(
    () => new Set(getPinnedTaskIds()),
  );
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [deletingSelection, setDeletingSelection] = useState(false);
  const deletingSelectionRef = useRef(false);
  const [archivingSelection, setArchivingSelection] = useState(false);
  const archivingSelectionRef = useRef(false);
  const selectionBusy = deletingSelection || archivingSelection;
  const selectionEpoch = useRef(0);
  // The row that started multi-select. An explicit Escape or Cancel hands the
  // keyboard back to it; every other way out (a batch, a filter change, a row
  // that was deleted) must leave focus where it is.
  const selectionOriginId = useRef<string | null>(null);
  // A row to focus on the next commit. Entering and leaving the mode both
  // replace the row element, so the browser drops focus to <body> unless it is
  // put back; Escape would then have no row in the list to travel through.
  const focusRowAfterCommit = useRef<string | null>(null);
  const [swipeOpen, setSwipeOpen] = useState<string | null>(null);
  // The manual order per bucket, read once the way pins are. A bucket without
  // an entry keeps the attention + recency rule.
  const [taskOrder, setTaskOrder] = useState<TaskOrder>(() => getTaskOrder());
  const [prefsTick, setPrefsTick] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectMenu, setProjectMenu] = useState<{
    bucket: PhoneProjectBucket;
    archived: boolean;
  } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeProjectSidebar(() => setPrefsTick((n) => n + 1)), []);
  useEffect(() => {
    selectionEpoch.current += 1;
    selectionOriginId.current = null;
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, [query, status, scope]);

  // A focused move is one-shot and belongs to the mode change itself: the ref
  // is consumed in the commit that flips `selectionMode`, so a later list
  // update cannot pull focus back — and a commit that lands between the key
  // press and that flip cannot spend the ref on a row the flip will replace.
  useEffect(() => {
    const id = focusRowAfterCommit.current;
    if (!id) return;
    focusRowAfterCommit.current = null;
    Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-session-row]") ?? [])
      .find((row) => row.dataset.sessionRow === id)
      ?.focus();
    // Only the mode flip consumes the ref; `selectionMode` is the whole input.
  }, [selectionMode]);

  const draftPrompt = useSyncExternalStore(subscribeDraft, getDraftPrompt, () => "");
  const draftCwd = useSyncExternalStore(subscribeDraft, getDraftCwd, () => "");
  const draftActive = location.pathname === DRAFT_PATH;
  const hasDraft = Boolean(draftActive || draftPrompt.trim());

  useEffect(() => {
    let cancelled = false;
    // An import event can start a second read while the first is still out.
    // Only the newest answer may land: a slow pre-import snapshot arriving
    // after the post-import one would put the old imported rows back.
    let seq = 0;
    setSessionsFailed(false);
    const read = () => {
      const mine = ++seq;
      const firstPage = ++firstPageSeq.current;
      firstPageInFlight.current = firstPage;
      setRefreshing(true);
      // A first-page refresh invalidates every older page and cursor in
      // flight, starting now rather than when the answer lands: a page read
      // from the old cursor describes a list that is being replaced. The
      // rows and cursor already on screen are not cleared here — only a
      // successful first page may replace them, so a failed refresh leaves
      // the old list (and paging from it) intact.
      requestGeneration.current += 1;
      olderToken.current += 1;
      setLoadingOlder(false);
      const term = sessionListParams(searchTerm);
      listAgentSessionsPage({ limit: term.limit, q: term.q })
        .then((page) => {
          if (cancelled || mine !== seq) return;
          setSessions(page.items);
          sessionCursorRef.current = page.next_cursor;
          setSessionCursor(page.next_cursor);
          setOlderSessions([]);
          setSessionsFailed(false);
          if (firstPageSeq.current === firstPage) {
            firstPageInFlight.current = null;
            setRefreshing(false);
          }
        })
        .catch(() => {
          if (cancelled || mine !== seq) return;
          setSessionsFailed(true);
          if (firstPageSeq.current === firstPage) {
            firstPageInFlight.current = null;
            setRefreshing(false);
          }
        });
    };
    read();
    // Imports and unlinks happen off this list: the sidebar footer, settings,
    // and an imported session's own page. `changed` is the event those
    // surfaces publish; `sync` is the manual import tick. Either one replaces
    // the imported half, which is otherwise only read on mount. A reconnect
    // is a read too: a failed index read must recover without a reload.
    window.addEventListener("kin:agent-sessions-sync", read);
    window.addEventListener("kin:agent-sessions-changed", read);
    return () => {
      cancelled = true;
      window.removeEventListener("kin:agent-sessions-sync", read);
      window.removeEventListener("kin:agent-sessions-changed", read);
    };
  }, [searchTerm, reconnectGen, sessionReload]);

  // Project records are how a project with no loaded conversation still gets a
  // heading. Failing to read them only loses those empty headings, never a row.
  useEffect(() => {
    let cancelled = false;
    listProjects("active")
      .then((list) => {
        if (!cancelled) setProjects(list);
      })
      .catch(() => {
        // Covers are optional.
      });
    return () => {
      cancelled = true;
    };
  }, [reconnectGen]);

  useEffect(() => {
    requestGeneration.current += 1;
    setOlderTasks([]);
    setOlderArchivedTasks([]);
    setTaskMore(null);
    setArchiveMore(null);
  }, [searchTerm, status]);

  useEffect(() => {
    if (scope !== "archived") return;
    requestGeneration.current += 1;
    setOlderArchivedTasks([]);
    setArchiveMore(null);
  }, [scope]);

  const selfDeviceId = (machines.find((machine) => machine.isSelf)?.id ?? "").trim();
  /** A bucket is local when its rows' device is this machine (or unnamed). The
   *  Hub's project records are this machine's filesystem only, so opening a
   *  cover, pinning, archiving and touching a project are local actions. A
   *  remote copy of the same path must never be pointed at them. An explicit
   *  device that cannot be proven to be this one is remote: with no self id
   *  (a failed machine list) the safe mistake is to withhold the local action,
   *  never to apply it to someone else's filesystem. */
  const bucketIsLocal = (bucket: PhoneProjectBucket): boolean =>
    !bucket.deviceId || (selfDeviceId !== "" && bucket.deviceId === selfDeviceId);
  const lastLoadedTasks = useRef<readonly Task[]>([]);
  useEffect(() => {
    if (taskList.loaded) lastLoadedTasks.current = taskList.data;
  }, [taskList.loaded, taskList.data]);
  const liveTasks = taskList.loaded ? taskList.data : lastLoadedTasks.current;
  const archivedList = useTaskList(
    sessionListParams(searchTerm, status, true),
    scope === "archived",
  );
  const lastLoadedArchivedTasks = useRef<readonly Task[]>([]);
  useEffect(() => {
    if (archivedList.loaded && !archivedList.error) {
      lastLoadedArchivedTasks.current = archivedList.data;
    }
  }, [archivedList.loaded, archivedList.error, archivedList.data]);
  const archivedTasks =
    archivedList.loaded && !archivedList.error
      ? archivedList.data
      : lastLoadedArchivedTasks.current;
  const liveRows = useMemo(
    () => mergeTaskTail(liveTasks, olderTasks, (id) => liveResources.taskSnapshot(id)),
    [liveTasks, olderTasks],
  );
  const archivedRows = useMemo(
    () => mergeTaskTail(archivedTasks, olderArchivedTasks, (id) => liveResources.taskSnapshot(id)),
    [archivedTasks, olderArchivedTasks],
  );
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
  const hasMoreTasks = taskMore ?? (taskList.pageFull || liveTasks.length >= taskLimit);
  const hasMoreArchive =
    scope === "archived" &&
    (archiveMore ?? (archivedList.pageFull || archivedTasks.length >= archiveLimit));
  const hasMoreSessions = Boolean(sessionCursor) && !status;

  // Opening a conversation from anywhere else in the shell still has to bump
  // its project and clear its completion dot; the list owns that bookkeeping
  // now that the sidebar no longer receives the task feed.
  const handledSelectionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeTaskId) {
      handledSelectionRef.current = null;
      return;
    }
    const task = liveRows.find((row) => row.id === activeTaskId);
    if (!task) return;
    if (task.cwd) touchProject(task.cwd);
    if (handledSelectionRef.current === activeTaskId) return;
    touchSession(activeTaskId);
    if (isTerminal(task.status)) markSessionViewed(task.id);
    handledSelectionRef.current = activeTaskId;
  }, [activeTaskId, liveRows]);

  const archivedCwds = useMemo(() => getArchivedProjects(), [prefsTick]);
  const pinnedProjects = useMemo(() => getPinnedProjects(), [prefsTick]);
  // A project's record names it; the folder is only its address. Every root of
  // every record is a heading, keyed the way buckets key a cwd, and the first
  // record wins on a duplicate root so a heading never depends on iteration
  // order. The records are this machine's own filesystem (the API has no device
  // column), which is also why `seedProjects` files them under this machine.
  const projectNameByCwd = useMemo(() => {
    const byKey = new Map<string, string>();
    for (const project of projects) {
      const name = project.name.trim();
      if (!name) continue;
      for (const root of project.roots ?? []) {
        const key = bucketKeyFor(root);
        if (key !== UNASSIGNED_PROJECT && !byKey.has(key)) byKey.set(key, name);
      }
    }
    return byKey;
  }, [projects]);
  // Search and status views still display the stored order, but a reorder is
  // offered only where the whole bucket is shown; the archive scope has no
  // manual order at all.
  const orders = useMemo(() => (scope === "active" ? taskOrder : undefined), [scope, taskOrder]);
  const buckets = useMemo(
    () =>
      phoneProjectBuckets(
        tasks,
        status ? [] : allSessions,
        selfDeviceId,
        {
          untitled: tr("sessions.untitled"),
          noProject: tr("sessions.noProject"),
          imported: tr("sessions.importedLabel"),
        },
        archivedCwds,
        scope,
        // Asked about the cwd rather than the bucket key: an archived remote
        // copy's key carries a device suffix that is not part of the address.
        (cwd) => projectNameByCwd.get(bucketKeyFor(cwd)),
        orders,
      ),
    [
      tasks,
      allSessions,
      status,
      scope,
      selfDeviceId,
      locale,
      archivedCwds,
      projectNameByCwd,
      orders,
    ],
  );
  // A project heading is where its cover lives, so a project with no row in the
  // loaded page is still drawn, with a count of 0 rather than omitted.
  //
  // Only from a trustworthy list: while a status filter is on, or the task feed
  // has failed or has not answered, "no rows" is not evidence the project is
  // empty, and seeding would replace "nothing matches" or a load error with a
  // wall of zero-count headings.
  const canSeed = scope === "active" && !status && taskList.loaded && !taskList.error;
  const seeded = useMemo(
    () => seedProjects(buckets, canSeed ? projects : [], archivedCwds, tr("sessions.noProject")),
    [buckets, projects, canSeed, archivedCwds, tr],
  );
  const filtered = useMemo(() => filterProjectBuckets(seeded, query), [seeded, query]);
  const listed = useMemo(
    () =>
      withPinnedBucket(
        filtered,
        scope === "archived" ? EMPTY_IDS : pinnedIds,
        tr("sessions.pinned"),
        orders,
      ),
    [filtered, pinnedIds, scope, tr, orders],
  );
  useEffect(() => {
    if (!returnRow) return;
    setReturnRow(consumeRowReturn(returnRow));
  }, [returnRow, listed]);
  const sortMode = useMemo(() => getProjectSortMode(), [prefsTick]);
  const { pinnedBucket, deviceGroups } = useMemo(() => {
    const pinned = listed.find((bucket) => bucket.key === PINNED_BUCKET);
    const groups = groupProjectBucketsByDevice(
      listed.filter((bucket) => bucket.key !== PINNED_BUCKET),
      machines,
      selfDeviceId,
    ).map((group) => ({
      ...group,
      buckets: sortSessionBuckets(group.buckets, {
        sortMode,
        // Pins and local recency are this machine's filesystem facts. A remote
        // copy of the same path must not inherit them: pinning `/work/shared`
        // here would lift the NAS's copy of it too, and touching the local one
        // would reorder the remote one.
        pinned: group.isSelf ? pinnedProjects : [],
        lastInteracted: group.isSelf ? getProjectLastInteracted() : {},
        archived: scope === "archived",
      }),
    }));
    return { pinnedBucket: pinned, deviceGroups: groups };
  }, [listed, machines, selfDeviceId, sortMode, pinnedProjects, prefsTick, scope]);
  const foldSets = useMemo(() => {
    const collapsed = new Set<string>();
    const openImported = new Set<string>();
    for (const [key, open] of Object.entries(folds)) {
      if (open) openImported.add(key);
      else collapsed.add(key);
    }
    return { collapsed, openImported };
  }, [folds]);
  const selectableCount = selectableTaskIds(listed, scope).length;
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const present = new Set(selectableTaskIds(listed, scope));
    const next = Array.from(selectedIds).filter((id) => present.has(id));
    if (next.length !== selectedIds.size) setSelectedIds(new Set(next));
  }, [listed, scope, selectedIds]);

  const archiveWaiting =
    scope === "archived" &&
    !archivedList.loaded &&
    !archivedList.error &&
    lastLoadedArchivedTasks.current.length === 0;
  const loading = (!taskList.loaded && tasks.length === 0) || machinesLoading || archiveWaiting;
  const now = Date.now();
  const viewedIds = useMemo(() => new Set(getViewedSessionIds()), [viewTick]);
  const searching = query.trim() !== "";
  // A reorder here would mean "reorder the current results", not the project:
  // the order is stored per bucket, so it is offered only where the bucket is
  // shown whole. The stored order still displays in the narrowed views.
  const canReorder = scope === "active" && !searching && !status && !selectionMode;
  const filtering = Boolean(status) || scope === "archived";
  const pendingQuery = query.trim() !== searchTerm;
  const archiveFailed = scope === "archived" && Boolean(archivedList.error);
  const archiveProjectsFailed = scope === "archived" && !archiveFailed && Boolean(taskList.error);
  const loadFailed = (Boolean(taskList.error) || archiveFailed) && listed.length === 0;
  // Imported sessions are a second index. Its failure is actionable on its own:
  // when it is the only feed with rows, the page must say what failed rather
  // than draw "no chats yet" over it.
  const importsFailed = !status && sessionsFailed;
  const importsFailedHard = importsFailed && !loading && listed.length === 0 && !loadFailed;
  // One retry for whatever this page is showing: the live list, and the archive
  // list when that scope is open. The button exists because the story promises
  // one (`KIN-CONTINUE-002`, step 6) and because waiting for an event to
  // repaint the list is not a next step a reader can take.
  const retryList = () => {
    void liveResources.refreshTaskList(sessionListParams(searchTerm, status));
    if (scope === "archived") {
      void liveResources.refreshTaskList(sessionListParams(searchTerm, status, true));
    }
    // The imported half is a second index with its own read; a Retry that only
    // refreshes tasks would leave the error it is answering in place.
    setSessionsFailed(false);
    setSessionReload((n) => n + 1);
  };
  const selectionAllPinned =
    selectedIds.size > 0 && Array.from(selectedIds).every((id) => pinnedIds.has(id));
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

  function setQuery(next: string) {
    const following = new URLSearchParams(params);
    // `search`, not `q` or `find`: `/new?q=` is the composer's prefill and
    // `/tasks/:id?find=` seeds the transcript find bar (it is consumed and
    // deleted there). The sidebar list is mounted on `/new` and beside the
    // open conversation, so either name would let a list search rewrite the
    // page next to it.
    if (next) following.set("search", next);
    else following.delete("search");
    setParams(following, { replace: true });
  }

  function changeFilter(next: { status: SessionStatusFilter; scope: SessionScopeFilter }) {
    const nextParams = new URLSearchParams(params);
    if (next.status) nextParams.set("status", next.status);
    else nextParams.delete("status");
    if (next.scope === "archived") nextParams.set("scope", "archived");
    else nextParams.delete("scope");
    setParams(nextParams, { replace: true });
  }

  function foldIsOpen(stateKey: string, imported: boolean): boolean {
    return folds[stateKey] ?? !imported;
  }

  function toggleFold(stateKey: string, imported: boolean) {
    setSessionFold(stateKey, !foldIsOpen(stateKey, imported));
    setFoldTick((n) => n + 1);
  }

  function renderBucket(bucket: PhoneProjectBucket, stateKey: string) {
    const imported = isImportedBucket(bucket.key);
    return (
      <ProjectBucket
        key={stateKey}
        bucket={bucket}
        machines={machines}
        now={now}
        viewedIds={viewedIds}
        pendingByTask={pendingByTask}
        collapsed={isBucketCollapsed({
          imported,
          stateKey,
          searching,
          collapsed: foldSets.collapsed,
          openImported: foldSets.openImported,
        })}
        showAll={searching || expanded.has(stateKey)}
        canToggle={!searching}
        onToggle={() => toggleFold(stateKey, imported)}
        onToggleShowAll={() =>
          setExpanded((current) => {
            const next = new Set(current);
            if (next.has(stateKey)) next.delete(stateKey);
            else next.add(stateKey);
            return next;
          })
        }
        onOpen={openRow}
        shell={shell}
        coarse={coarse}
        activeTaskId={activeTaskId}
        selectionMode={selectionMode}
        selectionLocked={selectionBusy}
        selectedIds={selectedIds}
        onToggleSelect={toggleSelected}
        onStartSelection={enterSelection}
        onExitSelection={() => exitSelection(true)}
        swipeOpen={swipeOpen}
        onSwipeOpenChange={setSwipeOpen}
        pinnedIds={pinnedIds}
        pinnedProjects={pinnedProjects}
        onPin={pinRow}
        onArchive={archiveRow}
        onDelete={deleteRow}
        onRestore={restoreRow}
        scope={scope}
        query={query}
        canReorder={canReorder}
        archived={scope === "archived"}
        onRestoreProject={
          scope === "archived" && bucketIsLocal(bucket) && archivedCwdFor(bucket.key, archivedCwds)
            ? () => {
                const cwd = archivedCwdFor(bucket.key, archivedCwds);
                if (cwd) unarchiveProject(cwd);
              }
            : undefined
        }
        local={bucketIsLocal(bucket)}
        hasStoredOrder={(taskOrder[bucket.key]?.length ?? 0) > 0}
        onRestoreOrder={() => {
          clearBucketOrder(bucket.key);
          setTaskOrder(getTaskOrder());
        }}
        onOpenProject={() => void openProject(bucket)}
        onNewSession={() => newSessionIn(bucket)}
        onArchiveProject={() => archiveProjectConfirmed(bucket)}
        onProjectMenu={() => setProjectMenu({ bucket, archived: scope === "archived" })}
      />
    );
  }

  function openRow(row: PhoneSessionRow) {
    // The sidebar is on screen beside a dirty project or settings page, so a
    // row click is a departure from that page and asks it first. On the phone
    // the row's parent is the list; `phonePush` keeps that true.
    runGuardedNavigation(() => {
      rememberRowReturn(row.task?.id ?? row.session!.id);
      if (!row.task) {
        const to = `/agent-sessions/${encodeURIComponent(row.session!.id)}${listStateQuery(params)}`;
        phonePush(navigate, location, to);
        return;
      }
      if (isTerminal(row.task.status)) markSessionViewed(row.task.id);
      const to = `/tasks/${encodeURIComponent(row.task.id)}${listStateQuery(params)}`;
      phonePush(navigate, location, to);
    });
  }

  function enterSelection(row: PhoneSessionRow) {
    if (!rowSelectable(row, scope)) return;
    selectionOriginId.current = row.task!.id;
    focusRowAfterCommit.current = row.task!.id;
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

  /** `restoreFocus` is for a person leaving on purpose (Escape, Cancel). Batch
   *  work and automatic cleanup leave the keyboard alone. */
  function exitSelection(restoreFocus = false) {
    const origin = selectionOriginId.current;
    selectionOriginId.current = null;
    selectionEpoch.current += 1;
    setSelectionMode(false);
    setSelectedIds(new Set());
    if (restoreFocus) focusRowAfterCommit.current = origin;
  }

  function pinSelected() {
    const ids = Array.from(selectedIds);
    const allPinned = ids.length > 0 && ids.every((id) => pinnedIds.has(id));
    let next = pinnedIds;
    for (const id of ids) next = new Set(setTaskPinned(id, !allPinned));
    setPinnedIds(next);
    exitSelection();
  }

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

  async function deleteRow(row: PhoneSessionRow) {
    if (!row.task) return;
    const id = row.task.id;
    setSwipeOpen(null);
    if (await deleteOne({ id, title: row.title })) {
      forgetPins([id]);
      if (activeTaskId === id) navigate("/");
    }
  }

  function forgetPins(ids: readonly string[]) {
    const current = new Set(getPinnedTaskIds());
    const pinned = ids.filter((id) => current.has(id));
    if (pinned.length === 0) return;
    let next: ReadonlySet<string> = current;
    for (const id of pinned) next = new Set(setTaskPinned(id, false));
    setPinnedIds(next);
  }

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
      if (activeTaskId && ids.includes(activeTaskId) && !outcome.failed.includes(activeTaskId)) {
        navigate("/");
      }
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

  async function loadOlder() {
    if (loadingOlder) return;
    // While a new first page is replacing the list, its cursor is the one in
    // flight, not the one this button was rendered from.
    if (firstPageInFlight.current !== null) return;
    const generation = requestGeneration.current;
    const token = ++olderToken.current;
    setLoadingOlder(true);
    try {
      if (hasMoreTasks) {
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
      if (sessionCursorRef.current && !status) {
        const cursor = sessionCursorRef.current;
        const term = sessionListParams(searchTerm);
        const page = await listAgentSessionsPage({
          limit: term.limit,
          q: term.q,
          before: cursor,
        });
        if (requestGeneration.current !== generation) return;
        // The cursor this page was read from must still be the list's cursor.
        // A refresh that started while the request was out has already
        // replaced it, and this answer belongs to a list that is gone.
        if (sessionCursorRef.current !== cursor) return;
        sessionCursorRef.current = page.next_cursor;
        setSessionCursor(page.next_cursor);
        setOlderSessions((current) => [...current, ...page.items]);
      }
    } catch {
      // Keep what is on screen and leave the button in place.
    } finally {
      // A refresh retires this read (and bumps the token); clearing the flag
      // then belongs to the newer read, not to an answer that may never come.
      if (olderToken.current === token) setLoadingOlder(false);
    }
  }

  async function openProject(bucket: PhoneProjectBucket) {
    if (!bucket.cwd) return;
    if (!bucketIsLocal(bucket)) return;
    const known = projects.find((project) =>
      (project.roots ?? []).some((root) => bucketKeyFor(root) === bucket.key),
    );
    if (known) {
      runGuardedNavigation(() =>
        phonePush(navigate, location, `/projects/${known.id}${listStateQuery(params)}`),
      );
      return;
    }
    try {
      const project = await ensureProject({ path: bucket.cwd, name: bucket.label });
      runGuardedNavigation(() =>
        phonePush(navigate, location, `/projects/${project.id}${listStateQuery(params)}`),
      );
    } catch {
      // A cover is optional; the list stays where it is.
    }
  }

  /** A project leaving the list is not one tap's worth of certainty: the hover
   *  control is 24px and its only reversal is the archived scope. */
  function archiveProjectConfirmed(bucket: PhoneProjectBucket) {
    if (!bucket.cwd) return;
    if (!bucketIsLocal(bucket)) return;
    if (!window.confirm(tr("nav.archiveConfirm", { project: bucket.label }))) return;
    archiveProject(bucket.cwd);
  }

  function newSessionIn(bucket: PhoneProjectBucket) {
    if (!bucket.cwd) return;
    runGuardedNavigation(() => {
      const local = bucketIsLocal(bucket);
      // A project record, its pin and its archive entry are this machine's
      // facts. Touching or unarchiving one because a remote copy of the same
      // path was clicked would edit the local project behind the reader's back.
      if (local) {
        touchProject(bucket.cwd);
        if (scope === "archived") unarchiveProject(bucket.cwd);
      }
      // The cwd and its machine travel together: a remote path with no machine
      // recorded would quietly become a local path in the draft.
      setDraftMachine(local ? "" : (bucket.deviceId ?? "").trim());
      setDraftCwd(bucket.cwd);
      const to = `${DRAFT_PATH}${listStateQuery(params, { cwd: bucket.cwd })}`;
      phonePush(navigate, location, to, {
        state: draftEntryState(listUrlFor(location.search)),
      });
    });
  }

  /** ↑/↓ walk the rows from the search field; Enter opens because a row is a
   *  button. Escape empties the query and gives the field back to the shell. */
  function sessionRows(): HTMLElement[] {
    return Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-session-row]") ?? []);
  }

  /** Alt+↑/↓: the focused row changes places inside its own bucket. Only a
   *  row that is a conversation (not a heading or the draft) takes part, and
   *  the ends clamp instead of wrapping. */
  function moveFocusedRow(step: -1 | 1) {
    const key = (document.activeElement as HTMLElement | null)?.dataset.sessionRow;
    if (!key) return;
    const bucket = listed.find((candidate) => candidate.rows.some((row) => row.key === key));
    if (!bucket) return;
    const ids = bucket.rows.map((row) => row.key);
    const from = ids.indexOf(key);
    // The destination is the neighbour on screen, not the neighbour in the
    // whole bucket: a truncated project draws only its first five rows, and a
    // move past the last drawn one would take the row out of the slice and
    // drop keyboard focus. A neighbour that belongs to another bucket has no
    // index here, so the move clamps instead of crossing projects.
    const rendered = sessionRows();
    const at = rendered.indexOf(document.activeElement as HTMLElement);
    const neighbour = at < 0 ? undefined : rendered[at + step];
    const to = neighbour ? ids.indexOf(neighbour.dataset.sessionRow ?? "") : -1;
    if (from < 0 || to < 0) return;
    ids.splice(from, 1);
    ids.splice(to, 0, key);
    setBucketOrder(bucket.key, ids);
    setTaskOrder(getTaskOrder());
    // The row keeps the keyboard: the same conversation, one place over. The
    // commit replaces the row element, so focus is restored after it paints.
    requestAnimationFrame(() => {
      sessionRows()
        .find((row) => row.dataset.sessionRow === key)
        ?.focus();
    });
  }

  function onSearchKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (isImeKeyEvent(event.nativeEvent)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setQuery("");
      event.currentTarget.blur();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = sessionRows();
    if (rows.length === 0) return;
    event.preventDefault();
    (event.key === "ArrowDown" ? rows[0] : rows[rows.length - 1])?.focus();
  }

  function onListKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || isImeKeyEvent(event.nativeEvent)) return;
    if (event.key === "Escape") {
      // Escape belongs to the field a person is typing in; only an active
      // selection claims it here, and it leaves through the same path as the
      // toolbar's Cancel so focus returns to the row that started it.
      if (!selectionMode) return;
      event.preventDefault();
      exitSelection(true);
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    // Alt turns the same keys into "move this row" — the same gesture (up and
    // down) at a second scope (where it sits). Where a move is not offered,
    // the keys keep their ordinary meaning instead of being swallowed.
    if (event.altKey && canReorder) {
      const rows = sessionRows();
      if (rows.indexOf(document.activeElement as HTMLElement) === -1) return;
      event.preventDefault();
      moveFocusedRow(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    const rows = sessionRows();
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    event.preventDefault();
    const next =
      event.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : Math.max(at - 1, 0);
    rows[next]?.focus();
  }

  const toolbar = (
    <SessionToolbar
      search={shell === "sidebar"}
      query={query}
      pendingQuery={pendingQuery}
      searchRef={searchRef}
      onQueryChange={setQuery}
      onSearchKeyDown={onSearchKeyDown}
      status={status}
      scope={scope}
      sortMode={sortMode}
      onFilterChange={changeFilter}
      onSortChange={(mode) => {
        setProjectSortMode(mode);
        setPrefsTick((n) => n + 1);
      }}
    />
  );

  const body = (
    <div ref={listRef} onKeyDown={onListKeyDown}>
      {loading && (
        <p className="px-4 py-10 text-center text-strong text-kin-muted">
          {tr("sessions.loading")}
        </p>
      )}

      {!loading && pendingQuery && listed.length === 0 && !loadFailed && (
        <p className="px-4 py-10 text-center text-strong text-kin-muted">
          {tr("sessions.searching")}
        </p>
      )}

      {!loading && loadFailed && (
        <MobileEmpty
          icon={<IconAlert size={30} />}
          title={tr("sessions.loadError")}
          hint={tr("sessions.loadErrorHint")}
          action={<Button onClick={retryList}>{tr("common.retry")}</Button>}
        />
      )}

      {!loading && !loadFailed && importsFailedHard && (
        <MobileEmpty
          icon={<IconAlert size={30} />}
          title={tr("sessions.agentSessionsLoadError")}
          hint={tr("sessions.agentSessionsLoadErrorHint")}
          action={<Button onClick={retryList}>{tr("common.retry")}</Button>}
        />
      )}

      {!loading &&
        !loadFailed &&
        !importsFailedHard &&
        !(pendingQuery && listed.length === 0) &&
        listed.length === 0 && (
          <MobileEmpty icon={emptyView.icon} title={emptyView.title} hint={emptyView.hint} />
        )}

      {selectionMode && (
        <SessionSelectionBar
          selectedCount={selectedIds.size}
          selectableCount={selectableCount}
          selectionBusy={selectionBusy}
          deletingSelection={deletingSelection}
          scope={scope}
          allPinned={selectionAllPinned}
          onSelectAll={selectAll}
          onPin={pinSelected}
          onArchiveOrRestore={scope === "archived" ? restoreSelected : archiveSelected}
          onDelete={deleteSelected}
          onExit={() => exitSelection(true)}
        />
      )}

      {!loading && hasDraft && (
        <DraftRow
          active={draftActive}
          label={tr("nav.draftChat")}
          detail={draftPrompt.trim() || draftCwd}
          onClick={() =>
            runGuardedNavigation(() => {
              phonePush(navigate, location, DRAFT_PATH, {
                state: draftEntryState(listUrlFor(location.search)),
              });
            })
          }
        />
      )}

      {!loading && pinnedBucket && renderBucket(pinnedBucket, pinnedBucket.key)}

      {!loading &&
        deviceGroups.map((group) => (
          <DeviceSection
            key={group.id || "__self__"}
            group={group}
            label={group.isSelf ? tr("nav.thisMachine") : group.label}
            shell={shell}
            renderBucket={renderBucket}
          />
        ))}

      {!loading && (hasMoreTasks || hasMoreArchive || hasMoreSessions) && (
        <Button
          variant="quiet"
          onClick={loadOlder}
          disabled={loadingOlder || refreshing}
          className="kin-row-press flex w-full items-center justify-center px-4 py-2 text-body font-medium text-kin-muted!"
        >
          {loadingOlder ? tr("sessions.loadingOlder") : tr("sessions.loadOlder")}
        </Button>
      )}

      {!loading && (archiveFailed || archiveProjectsFailed) && listed.length > 0 && (
        <p className="px-4 py-6 text-center text-body text-kin-muted">
          {tr(archiveFailed ? "sessions.archiveLoadFailed" : "sessions.archiveProjectsLoadFailed")}
        </p>
      )}

      {!loading && importsFailed && listed.length > 0 && (
        <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
          <p className="text-body text-kin-muted">{tr("sessions.agentSessionsFailed")}</p>
          <Button variant="secondary" onClick={retryList}>
            {tr("common.retry")}
          </Button>
        </div>
      )}
    </div>
  );

  const projectSheet = (
    <ActionSheet
      open={projectMenu !== null}
      onClose={() => setProjectMenu(null)}
      title={projectMenu?.bucket.label}
      anyWidth={coarse}
      rows={
        projectMenu
          ? [
              {
                id: "new-session",
                label: tr("nav.newSessionIn", { project: projectMenu.bucket.label }),
                onSelect: () => newSessionIn(projectMenu.bucket),
              },
              // Pin, cover and archive are this machine's project facts. A
              // remote copy is offered only the action that works there (a new
              // session, which keeps its machine) rather than rows that would
              // silently do nothing.
              ...(projectMenu.archived || !bucketIsLocal(projectMenu.bucket)
                ? []
                : [
                    {
                      id: "pin",
                      label: pinnedProjects.some(
                        (cwd) => bucketKeyFor(cwd) === projectMenu.bucket.key,
                      )
                        ? tr("nav.unpinProject")
                        : tr("nav.pinProject"),
                      onSelect: () => {
                        if (projectMenu.bucket.cwd) toggleProjectPinned(projectMenu.bucket.cwd);
                      },
                    },
                  ]),
              // The way back out of a manual order. Offered only when this
              // project actually has one; restoring is a preference, not a
              // deletion, so it takes no red ink. The order is stored per
              // bucket in this browser and applies to a remote copy too, so
              // the reset does not follow the local project record.
              ...(!projectMenu.archived && (taskOrder[projectMenu.bucket.key]?.length ?? 0) > 0
                ? [
                    {
                      id: "restore-order",
                      label: tr("nav.restoreTimeOrder"),
                      onSelect: () => {
                        clearBucketOrder(projectMenu.bucket.key);
                        setTaskOrder(getTaskOrder());
                      },
                    },
                  ]
                : []),
              ...(!bucketIsLocal(projectMenu.bucket)
                ? []
                : [
                    {
                      id: "cover",
                      label: tr("nav.openCover"),
                      onSelect: () => void openProject(projectMenu.bucket),
                    },
                    {
                      id: "archive",
                      label: projectMenu.archived
                        ? tr("nav.unarchiveProject")
                        : tr("nav.archiveProject"),
                      destructive: true,
                      onSelect: () => {
                        if (!projectMenu.bucket.cwd) return;
                        if (!bucketIsLocal(projectMenu.bucket)) return;
                        if (projectMenu.archived) unarchiveProject(projectMenu.bucket.cwd);
                        else archiveProjectConfirmed(projectMenu.bucket);
                      },
                    },
                  ]),
            ]
          : []
      }
    />
  );

  if (shell === "sidebar") {
    return (
      <>
        {toolbar}
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">{body}</div>
        {projectSheet}
      </>
    );
  }

  return (
    <MobileScreen
      scrollKey="kin.listScroll"
      // Count rows, not headings. The archive scope seeds a heading for every
      // archived project before any of its rows exist, so the heading count is
      // already final at mount and the restore would never retry. While the
      // body is still the loading line the rows are not on screen, so the
      // signal stays at -1 and moves again when the real content paints.
      scrollWhen={loading ? -1 : listed.reduce((n, bucket) => n + bucket.rows.length, 0)}
      className="mx-auto w-full max-w-2xl"
    >
      {toolbar}
      {body}
      {/* Room under the last row for the floating new-chat button, so the
          end of the list can scroll clear of it. */}
      <div className="h-20" aria-hidden />
      {projectSheet}
    </MobileScreen>
  );
}

/**
 * Project records can name one or more roots; each root is a heading.
 *
 * A project record is the local node's own (the API has no device id because
 * there is only one machine's filesystem behind it), which is why a seeded
 * heading is filed under this machine. A root the reader archived locally is
 * skipped: the daemon still calls the project active, and re-adding it here
 * would resurrect the heading the archive was meant to hide.
 */
function seedProjects(
  buckets: readonly PhoneProjectBucket[],
  projects: readonly Project[],
  archivedCwds: readonly string[],
  noProject: string,
): PhoneProjectBucket[] {
  const archived = new Set(archivedCwds.map((cwd) => bucketKeyFor(cwd)));
  const seen = new Set(buckets.map((bucket) => bucket.key));
  const extra: PhoneProjectBucket[] = [];
  for (const project of projects) {
    for (const root of project.roots ?? []) {
      const key = bucketKeyFor(root);
      if (!key || key === UNASSIGNED_PROJECT || archived.has(key) || seen.has(key)) continue;
      seen.add(key);
      extra.push({
        key,
        label: project.name.trim() || tailOf(root) || noProject,
        cwd: root,
        rows: [],
        lastActivityAt: project.last_active_at ?? 0,
        createdAt: project.created_at ?? 0,
        hasActiveTask: false,
      });
    }
  }
  return [...buckets, ...extra];
}

function tailOf(cwd: string): string {
  return cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
}

function DeviceSection({
  group,
  label,
  shell,
  renderBucket,
}: {
  group: PhoneDeviceGroup;
  label: string;
  shell: "sidebar" | "page";
  renderBucket: (bucket: PhoneProjectBucket, stateKey: string) => ReactNode;
}) {
  const tr = useT();
  const sidebar = shell === "sidebar";
  return (
    <section aria-label={label}>
      <div
        className={["flex items-center gap-1.5 pb-0.5 pt-3", sidebar ? "px-2" : "px-4"].join(" ")}
      >
        <IconMachine size={14} className="flex-none text-kin-muted" />
        <span
          className={[
            "h-1.5 w-1.5 flex-none rounded-full",
            group.online ? "bg-kin-green" : "bg-kin-muted/40",
          ].join(" ")}
          title={group.online ? tr("nav.machineOnline") : tr("nav.machineOffline")}
          aria-hidden
        />
        <h2
          className={[
            "min-w-0 flex-1 truncate",
            sidebar
              ? // KIN-CONTINUE-002 keeps the one shared list; #47's depth rule
                // lives here now: the machine is the outermost, semibold level.
                "text-body font-semibold text-kin-secondary"
              : "text-caption font-semibold uppercase tracking-label text-kin-muted",
          ].join(" ")}
        >
          {label}
          <span className="sr-only">
            {group.online ? ` · ${tr("nav.machineOnline")}` : ` · ${tr("nav.machineOffline")}`}
          </span>
        </h2>
        <span className="flex-none text-caption tabular-nums text-kin-muted">{group.count}</span>
      </div>
      {/* One indent step per level in the sidebar: machine at the rail's
          gutter, its projects one step in, a project's rows one step in
          again. `data-sidebar-indent` names the level so the hierarchy test
          can read the step without measuring a layout jsdom does not have. */}
      <div
        data-sidebar-indent={sidebar ? "project" : undefined}
        className={sidebar ? "pl-4" : undefined}
      >
        {group.buckets.map((bucket) => renderBucket(bucket, `${group.id}::${bucket.key}`))}
      </div>
    </section>
  );
}

function DraftRow({
  active,
  label,
  detail,
  onClick,
}: {
  active: boolean;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    /* eslint-disable-next-line kin/no-raw-button --
       The draft is a full-width navigation row, not a button-shaped action:
       it is the list's first row and the design system has no row primitive. */
    <button
      type="button"
      onClick={onClick}
      className={[
        "kin-row-press flex min-h-11 w-full items-center gap-2.5 px-4 py-2.5 text-left",
        active ? "bg-[var(--kin-fill)]" : "",
      ].join(" ")}
    >
      <span className="flex w-2 flex-none justify-center">
        <span className="h-1.5 w-1.5 rounded-full bg-kin-blue" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate text-subtitle font-medium leading-ui text-kin-text">
        {label}
      </span>
      {detail ? (
        <span className="max-w-[9rem] flex-none truncate text-caption text-kin-muted">
          {detail}
        </span>
      ) : null}
    </button>
  );
}

function ProjectBucket({
  bucket,
  machines,
  now,
  viewedIds,
  pendingByTask,
  collapsed,
  showAll,
  canToggle,
  onToggle,
  onToggleShowAll,
  onOpen,
  shell,
  coarse,
  activeTaskId,
  selectionMode,
  selectionLocked,
  selectedIds,
  onToggleSelect,
  onStartSelection,
  onExitSelection,
  swipeOpen,
  onSwipeOpenChange,
  pinnedIds,
  pinnedProjects,
  onPin,
  onArchive,
  onDelete,
  onRestore,
  scope,
  query,
  canReorder,
  archived,
  local,
  hasStoredOrder,
  onRestoreOrder,
  onRestoreProject,
  onOpenProject,
  onNewSession,
  onArchiveProject,
  onProjectMenu,
}: {
  bucket: PhoneProjectBucket;
  machines: readonly Machine[];
  query: string;
  now: number;
  viewedIds: ReadonlySet<string>;
  pendingByTask: ReadonlyMap<string, number>;
  collapsed: boolean;
  showAll: boolean;
  canToggle: boolean;
  onToggle: () => void;
  onToggleShowAll: () => void;
  onOpen: (row: PhoneSessionRow) => void;
  shell: "sidebar" | "page";
  coarse: boolean;
  activeTaskId: string | null;
  selectionMode: boolean;
  selectionLocked: boolean;
  selectedIds: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  onStartSelection: (row: PhoneSessionRow) => void;
  onExitSelection: () => void;
  swipeOpen: string | null;
  onSwipeOpenChange: (open: string | null) => void;
  pinnedIds: ReadonlySet<string>;
  pinnedProjects: readonly string[];
  onPin: (row: PhoneSessionRow) => void;
  onArchive: (row: PhoneSessionRow) => void;
  onDelete: (row: PhoneSessionRow) => void;
  onRestore: (row: PhoneSessionRow) => void;
  scope: SessionScopeFilter;
  /** Alt+↑/↓ moves a row here; each row carries the hint while it does. */
  canReorder: boolean;
  archived: boolean;
  /** This bucket's rows run on this machine, so the local project record —
   *  cover, pin, archive — describes it. */
  local: boolean;
  /** A manual order is stored for this bucket in this browser. */
  hasStoredOrder: boolean;
  onRestoreOrder: () => void;
  onRestoreProject?: () => void;
  onOpenProject: () => void;
  onNewSession: () => void;
  onArchiveProject: () => void;
  onProjectMenu: () => void;
}) {
  const tr = useT();
  const rows = showAll ? bucket.rows : bucket.rows.slice(0, ROWS_BEFORE_SHOW_ALL);
  const hidden = bucket.rows.length - rows.length;
  const showAllLabel =
    hidden > 0
      ? tr("sessions.showAll", { count: String(bucket.rows.length) })
      : tr("sessions.showLess");
  const imported = isImportedBucket(bucket.key);
  const realProject = Boolean(bucket.cwd) && !imported;
  // A remote copy of a path has no Hub-side cover on this machine, so its
  // heading folds the project rather than opening the local one.
  const openable = realProject && local;
  const heading = imported
    ? tr("sessions.imported", { count: String(bucket.rows.length) })
    : bucket.label;
  const gutter = shell === "sidebar" ? "px-2" : "px-4";
  const pinnedProject = pinnedProjects.some((cwd) => bucketKeyFor(cwd) === bucket.key);

  return (
    <section className="pb-1">
      <div className={`group/proj relative flex items-center gap-0.5 ${gutter} pb-1 pt-4`}>
        <Button
          variant="quiet"
          onClick={() => {
            if (canToggle) onToggle();
          }}
          aria-expanded={!collapsed}
          aria-disabled={canToggle ? undefined : true}
          tabIndex={canToggle ? undefined : -1}
          aria-label={`${tr(collapsed ? "nav.expandProject" : "nav.collapseProject")} ${heading}`}
          className={[
            "kin-row-press flex flex-none items-center justify-center rounded-lg p-0 text-kin-muted!",
            coarse ? "h-11 min-h-11 w-11" : "h-9 w-7",
            canToggle ? "" : "opacity-40",
          ].join(" ")}
        >
          <IconChevronDown
            size={14}
            strokeWidth={2.25}
            className={["transition-transform duration-150", collapsed ? "-rotate-90" : ""].join(
              " ",
            )}
          />
        </Button>
        {/* eslint-disable-next-line kin/no-raw-button --
            The heading is the project's own navigation row, not an action:
            opening its cover and folding its rows are its two tap targets,
            and the design system has no row primitive. */}
        <button
          type="button"
          onClick={openable ? onOpenProject : onToggle}
          aria-label={heading}
          aria-expanded={openable ? undefined : !collapsed}
          className="kin-row-press flex min-h-11 min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {imported ? (
            <IconSessions size={18} className="flex-none text-kin-muted" />
          ) : collapsed ? (
            <IconFolder size={20} className="flex-none text-kin-muted" strokeWidth={1.75} />
          ) : (
            <IconFolderOpen size={20} className="flex-none text-kin-muted" strokeWidth={1.75} />
          )}
          <span
            className={[
              "min-w-0 truncate",
              shell === "sidebar"
                ? "text-body font-medium text-kin-secondary"
                : "text-strong font-semibold text-kin-muted",
            ].join(" ")}
          >
            <HighlightedText text={heading} query={query} />
          </span>
          {!imported ? (
            <span className="flex-none text-caption tabular-nums text-kin-muted">
              {bucket.rows.length}
            </span>
          ) : null}
        </button>
        {onRestoreProject ? (
          <Button
            variant="secondary"
            onClick={onRestoreProject}
            aria-label={`${tr("sessions.restore")} ${bucket.label}`}
            className="h-11 flex-none items-center gap-1.5 rounded-lg px-2.5 text-caption font-medium"
          >
            <IconRefresh size={13} />
            {tr("sessions.restore")}
          </Button>
        ) : null}
        {hasStoredOrder && !archived && !realProject && !imported ? (
          /*
            Pinned and No-project are synthetic buckets: they have no `cwd` and
            therefore no project record, so neither the fine-pointer hover strip
            nor the coarse-pointer project menu draws for them. Without this
            heading control a manual order written inside one (a drag or
            Alt+↑/↓ stores it under `__pinned__` / `__unassigned__`) would have
            no way back to recent activity.
          */
          <Button
            variant="quiet"
            aria-label={tr("nav.restoreTimeOrder")}
            onClick={onRestoreOrder}
            className={[
              "kin-row-press flex flex-none items-center justify-center rounded-lg p-0 text-kin-muted!",
              coarse ? "h-11 min-h-11 w-11" : "h-9 w-8",
            ].join(" ")}
          >
            <IconRefresh size={14} />
          </Button>
        ) : null}
        {realProject && !onRestoreProject && !coarse ? (
          /*
            The hover actions float over the row's tail instead of holding a
            column of their own. In layout they reserved four 24px boxes even at
            rest, so a 304px sidebar truncated “[seed] Project Alpha”, “Beta”
            and “Gamma” to the same “[seed] Projec… 0” while empty space sat to
            the right of the count. They stay in the tab order, and focus (or
            hover) reveals them over a background so the title under them is
            covered, not mixed with.
          */
          <div
            className={[
              "pointer-events-none absolute bottom-1 top-4 z-10 flex items-center rounded-md opacity-0 transition-opacity",
              gutter === "px-2" ? "right-2" : "right-4",
              gutter === "px-2" ? "bg-[var(--kin-sidebar)]" : "bg-[var(--kin-page)]",
              "focus-within:pointer-events-auto focus-within:opacity-100 group-hover/proj:pointer-events-auto group-hover/proj:opacity-100",
            ].join(" ")}
          >
            <ProjectIconButton
              label={tr("nav.newSessionIn", { project: bucket.label })}
              onClick={onNewSession}
            >
              <IconPlus size={12} />
            </ProjectIconButton>
            <ProjectIconButton
              label={local ? tr("nav.openCover") : tr("nav.openCoverLocalOnly")}
              onClick={onOpenProject}
              disabled={!local}
            >
              <IconFile size={12} />
            </ProjectIconButton>
            {local && !archived ? (
              <>
                <ProjectIconButton
                  label={pinnedProject ? tr("nav.unpinProject") : tr("nav.pinProject")}
                  onClick={() => {
                    if (bucket.cwd) toggleProjectPinned(bucket.cwd);
                  }}
                  active={pinnedProject}
                >
                  <IconPin size={12} strokeWidth={pinnedProject ? 2.2 : 1.7} />
                </ProjectIconButton>
                <ProjectIconButton label={tr("nav.archiveProject")} onClick={onArchiveProject}>
                  <IconArchive size={12} />
                </ProjectIconButton>
              </>
            ) : null}
            {hasStoredOrder && !archived ? (
              <ProjectIconButton label={tr("nav.restoreTimeOrder")} onClick={onRestoreOrder}>
                <IconRefresh size={12} />
              </ProjectIconButton>
            ) : null}
          </div>
        ) : null}
        {realProject && coarse ? (
          <Button
            variant="quiet"
            title={tr("nav.projectActions")}
            aria-label={tr("nav.projectActions")}
            aria-haspopup="dialog"
            onClick={onProjectMenu}
            className="h-11 w-11 flex-none items-center justify-center rounded-full p-0 text-kin-muted!"
          >
            <IconMore size={18} />
          </Button>
        ) : null}
      </div>

      {!collapsed && (
        <div
          data-sidebar-indent={shell === "sidebar" ? "session" : undefined}
          className={shell === "sidebar" ? "pl-4" : undefined}
        >
          {rows.map((row) => (
            <SessionRow
              key={row.key}
              row={row}
              deviceLabel={pinnedRowDeviceName(bucket.key, row, machines)}
              now={now}
              viewedIds={viewedIds}
              pendingCount={row.task ? (pendingByTask.get(row.task.id) ?? 0) : 0}
              active={Boolean(row.task && row.task.id === activeTaskId)}
              onOpen={() => onOpen(row)}
              shell={shell}
              coarse={coarse}
              selectionMode={selectionMode}
              selectionLocked={selectionLocked}
              selected={row.task ? selectedIds.has(row.task.id) : false}
              onToggleSelect={() => {
                if (row.task) onToggleSelect(row.task.id);
              }}
              onStartSelection={() => onStartSelection(row)}
              onExitSelection={onExitSelection}
              swipeOpen={swipeOpen === row.key}
              onSwipeOpenChange={(open) => onSwipeOpenChange(open ? row.key : null)}
              pinned={row.task ? pinnedIds.has(row.task.id) : false}
              onPin={() => onPin(row)}
              onArchive={() => onArchive(row)}
              onDelete={() => onDelete(row)}
              onRestore={() => onRestore(row)}
              scope={scope}
              query={query}
              reorderHint={canReorder && !imported}
            />
          ))}
          {canToggle && (hidden > 0 || bucket.rows.length > ROWS_BEFORE_SHOW_ALL) ? (
            <Button
              variant="quiet"
              onClick={onToggleShowAll}
              aria-expanded={showAll}
              aria-label={showAllLabel}
              className="kin-row-press flex w-full items-center gap-2.5 px-4 text-left text-body font-medium text-kin-muted!"
            >
              <span className="w-2 flex-none" aria-hidden />
              <span className="min-w-0 truncate">{showAllLabel}</span>
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ProjectIconButton({
  label,
  onClick,
  active = false,
  disabled = false,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    /* eslint-disable-next-line kin/no-raw-button --
       A 24px hover-revealed project icon is a desktop density affordance
       inside the heading line; the shared Button's touch floor and padding
       would break that line. Its touch counterpart is the project menu. */
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={[
        "touch-hide inline-flex h-6 w-6 items-center justify-center rounded-md transition-opacity",
        disabled
          ? "cursor-not-allowed text-kin-muted opacity-50"
          : active
            ? "text-kin-blue-ink opacity-100"
            : "text-kin-muted hover:bg-[var(--kin-fill-strong)] hover:text-kin-text",
      ].join(" ")}
    >
      {children}
    </button>
  );
}
