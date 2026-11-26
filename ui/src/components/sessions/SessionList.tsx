import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  ApiError,
  archiveTask,
  getAgentSession,
  getOnePager,
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
import { draftEntryState, isPhoneLayout, listUrlFor, phonePush } from "../../lib/phoneNavigation";
import { rememberDeviceNewReturn, takeDeviceNewReturn } from "../../lib/placeReturn";
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
import { projectInstructions } from "../../lib/projectInstructions";
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
  type PhoneProjectRecord,
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
import { resolveSessionListFolds, type SessionListFoldCandidate } from "../../lib/sessionListFolds";
import { sessionListParams } from "../../lib/sessionListParams";
import { rowSelectable, selectableTaskIds } from "../../lib/sessionSelection";
import {
  getViewedSessionIds,
  markSessionViewed,
  subscribeSessionViewed,
} from "../../lib/sessionViewed";
import { getPinnedTaskIds, setTaskPinned } from "../../lib/taskPins";
import { setLocalTaskTitle, useLocalTaskTitles } from "../../lib/taskTitles";
import {
  clearBucketOrder,
  getTaskOrder,
  setBucketOrder,
  type TaskOrder,
} from "../../lib/taskOrder";
import { mergeTaskTail } from "../../lib/taskTail";
import AgentSessionSheet, { type AgentSessionSheetClose } from "./AgentSessionSheet";
import ActionSheet from "../ui/ActionSheet";
import Button from "../ui/Button";
import InlineAlert from "../ui/InlineAlert";
import { SessionListSkeleton, SkeletonLine } from "../Skeleton";
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
  IconPencil,
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
import ProjectRootsEditor from "./ProjectRootsEditor";
import ProjectSummaryEditor from "./ProjectSummaryEditor";
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
 * The query, status, scope and project live in the URL (`?search=`, `?status=`,
 * `?scope=`, `?project=`), so switching width cannot change what the list is
 * showing: the route stays put and both shells read the same parameters.
 * Project order is the existing sidebar preference, which is why it appears in
 * both shells' filter panel.
 */
const LIST_STATE_KEYS = ["search", "status", "scope", "routine", "project"] as const;

/** The one conversation list, and the only screen a project's name opens. */
const LIST_PATH = "/sessions";

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

const ROWS_BEFORE_SHOW_ALL = 10;
const EMPTY_IDS: ReadonlySet<string> = new Set();
const SEARCH_DEBOUNCE_MS = 200;
// How long a closing deep-linked sheet waits for its own history entry to be
// handed back before the parameter is cleared anyway. The pop is one frame in
// practice; the bound keeps a lost entry from holding the URL hostage.
const SHEET_ENTRY_RETURN_MS = 1000;

/** The drag in flight: which bucket, which row, the order being drawn, and
 *  how far the row has followed the finger. */
type SessionDrag = {
  bucketKey: string;
  key: string;
  ids: string[];
  offsetY: number;
};

/** One project's work-instructions read, cached under the project id. */
type ProjectInstructionsEntry = {
  /** The answer has landed at least once; cached text paints on re-expand. */
  loaded: boolean;
  loading: boolean;
  /** The newest read failed; the block shows its sentence and Retry. */
  failed: boolean;
  markdown: string;
};

/** The deep-linked imported session (`?agent=`), read once for this id. */
type AgentEntry = {
  id: string;
  /** The snapshot the sheet opens on; null until the read lands. */
  session: AgentSession | null;
  /** The read failed; the list shows its inline alert and Retry. */
  failed: boolean;
};

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
  const wsStatus = useAppStore((s) => s.wsStatus);
  const { deleteOne, deleteMany } = useSessionDeletion();
  const navigate = useNavigate();
  const location = useLocation();
  const coarse = useCoarsePointer();
  const [params, setParams] = useSearchParams();
  const query = params.get("search") ?? "";
  const searching = query.trim() !== "";
  const status = normalizeStatusFilter(params.get("status"));
  const scope = normalizeScopeFilter(params.get("scope"));
  // One routine's runs, by id. The list never fetches routine names: a run's
  // title is its routine's title, so the row already says which routine it is.
  const routineId = (params.get("routine") ?? "").trim();
  const routineFilter = routineId !== "";
  // One project's conversations, by id (`?project=`). The task header's
  // project label lands here. The feed has no project_id filter, so the
  // narrowing happens over the loaded rows in the browser; the chip is the way
  // back.
  const projectId = (params.get("project") ?? "").trim();
  const projectFilter = projectId !== "";
  // One imported session's sheet, by id (`?agent=`). The retired
  // `/agent-sessions/:id` URL lands here, so the id is the sheet's open state:
  // no second copy that can drift from the URL the reader can reload.
  const agentId = (params.get("agent") ?? "").trim();

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

  const taskList = useTaskList(sessionListParams(searchTerm, status, false, routineId));
  const pending = usePendingResources();
  const pendingByTask = useMemo(() => pendingCountsByTask(pending.data), [pending.data]);
  const { machines, loading: machinesLoading, failed: machinesFailed } = useMachines();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  // The imported rows already on screen, so a deep link can open on the row
  // snapshot instead of a second read. A ref, not a dependency: a list
  // refresh must not restart the entry's own read.
  const sessionsRef = useRef<AgentSession[]>([]);
  sessionsRef.current = sessions;
  // A deep link (`?agent=`) opens the same sheet the row does.
  const [agentEntry, setAgentEntry] = useState<AgentEntry | null>(null);
  const [agentEntryAttempt, setAgentEntryAttempt] = useState(0);
  // Set while a close gives the sheet's history entry back; a read that is
  // already out must not reopen the sheet the reader just put away.
  const dismissedAgent = useRef<string | null>(null);
  // The URL is the state: read the id it names once, open the sheet on that
  // snapshot, and let the sheet's own refresh replace it. A reader who closes
  // the sheet (or moves to another id) before this answer lands never sees it.
  useEffect(() => {
    if (!agentId) {
      dismissedAgent.current = null;
      setAgentEntry(null);
      return;
    }
    if (dismissedAgent.current === agentId) return;
    const loaded = sessionsRef.current.find((item) => item.id === agentId);
    if (loaded) {
      setAgentEntry({ id: agentId, session: loaded, failed: false });
      return;
    }
    let cancelled = false;
    setAgentEntry({ id: agentId, session: null, failed: false });
    void getAgentSession(agentId).then(
      (found) => {
        // AGENTS 11: the answer names the id it answers, and a stale one never
        // opens a sheet under the id the URL holds now.
        if (cancelled || dismissedAgent.current === agentId) return;
        setAgentEntry({ id: agentId, session: found, failed: false });
      },
      () => {
        // The list stays readable; the failure is an inline alert over it with
        // its own retry, and the parameter stays so a reload tries again.
        if (cancelled || dismissedAgent.current === agentId) return;
        setAgentEntry({ id: agentId, session: null, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agentId, agentEntryAttempt]);
  const urlAgentEntry = agentEntry && agentEntry.id === agentId ? agentEntry : null;
  const urlAgentSession = urlAgentEntry?.session ?? null;
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
  // Which projects have their 「工作方式」 disclosure open. Keyed by project
  // record id, not by the fold key: the answer belongs to the project, so it
  // survives folding the project or narrowing the list, and the row comes back
  // the way the person left it. In memory, because the story adds no storage
  // key (KIN-CONTINUE-007).
  const [openInstructions, setOpenInstructions] = useState<ReadonlySet<string>>(() => new Set());
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(
    () => new Set(getPinnedTaskIds()),
  );
  // This browser's renames. The row's title is composed during bucketing, so
  // the list draws from this state rather than reading storage per row; the
  // hook is also what re-reads a title written by another mounted surface.
  const [localTitles, setLocalTitles] = useLocalTaskTitles();
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
  const [drag, setDrag] = useState<SessionDrag | null>(null);
  // Pointer moves land between renders, so the drag's mutable state has a
  // synchronous copy; `drag` is what the list draws from.
  const dragRef = useRef<SessionDrag | null>(null);
  const dragOriginY = useRef<number | null>(null);
  // The lifted row's top before it moved. The reorder draws the row in a new
  // DOM slot, so the transform is measured from this start rather than from
  // the finger's raw travel: otherwise the slot and the transform would both
  // carry the row.
  const dragStartTop = useRef<number | null>(null);
  const [prefsTick, setPrefsTick] = useState(0);
  const [projects, setProjects] = useState<Project[]>([]);
  // Work instructions are read lazily, once per project, when its row is
  // expanded. Keyed by project id so an answer can only ever paint under the
  // heading that asked for it.
  const [projectInstructions, setProjectInstructions] = useState<
    Record<string, ProjectInstructionsEntry>
  >({});
  // One generation per project id. A re-expand refreshes, and the newer read
  // owns the cache; a late answer from the previous one is dropped rather than
  // overwriting fresher text.
  const instructionsGeneration = useRef(new Map<string, number>());
  const [projectMenu, setProjectMenu] = useState<{
    bucket: PhoneProjectBucket;
    archived: boolean;
    /** The local project record behind the bucket, when it has one. */
    recordProjectId: string | null;
  } | null>(null);
  // The cover's two editors, moved to the row. They open over the list, so
  // the list has to own which project each one is for.
  const [summaryProjectId, setSummaryProjectId] = useState<string | null>(null);
  // An imported agent session opens over the list. The row's own snapshot
  // heads the sheet before its read lands, so the tapped row is the state.
  const [agentSheet, setAgentSheet] = useState<AgentSession | null>(null);
  const [rootsProjectId, setRootsProjectId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeProjectSidebar(() => setPrefsTick((n) => n + 1)), []);
  useEffect(() => {
    selectionEpoch.current += 1;
    selectionOriginId.current = null;
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, [query, status, scope, routineId]);

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
  }, [searchTerm, status, routineId]);

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
  const offline = wsStatus === "disconnected";
  const readProjectInstructions = useCallback((projectId: string) => {
    const generation = (instructionsGeneration.current.get(projectId) ?? 0) + 1;
    instructionsGeneration.current.set(projectId, generation);
    setProjectInstructions((current) => {
      const cached = current[projectId];
      return {
        ...current,
        // A cached answer keeps painting while the refresh is out; only the
        // first read of a block shows its skeleton (TASTE 15).
        [projectId]: {
          loaded: cached?.loaded ?? false,
          loading: true,
          failed: false,
          markdown: cached?.markdown ?? "",
        },
      };
    });
    getOnePager(projectId)
      .then((onePager) => {
        if (instructionsGeneration.current.get(projectId) !== generation) return;
        setProjectInstructions((current) => ({
          ...current,
          [projectId]: {
            loaded: true,
            loading: false,
            failed: false,
            markdown: onePager.markdown,
          },
        }));
      })
      .catch((error: unknown) => {
        if (instructionsGeneration.current.get(projectId) !== generation) return;
        // A project with no ONE_PAGER.md yet has an empty section, not a failed
        // read (the cover's rule): the block offers the write launcher.
        if (error instanceof ApiError && error.status === 404) {
          setProjectInstructions((current) => ({
            ...current,
            [projectId]: { loaded: true, loading: false, failed: false, markdown: "" },
          }));
          return;
        }
        setProjectInstructions((current) => {
          const cached = current[projectId];
          return {
            ...current,
            [projectId]: {
              loaded: cached?.loaded ?? false,
              loading: false,
              failed: true,
              markdown: cached?.markdown ?? "",
            },
          };
        });
      });
  }, []);
  const lastLoadedTasks = useRef<readonly Task[]>([]);
  useEffect(() => {
    if (taskList.loaded) lastLoadedTasks.current = taskList.data;
  }, [taskList.loaded, taskList.data]);
  const liveTasks = taskList.loaded ? taskList.data : lastLoadedTasks.current;
  const archivedList = useTaskList(
    sessionListParams(searchTerm, status, true, routineId),
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
    () => sessionFeedTasks(liveRows, archivedRows, scope, status, routineId),
    [liveRows, archivedRows, status, scope, routineId],
  );
  const allSessions = useMemo(() => {
    if (olderSessions.length === 0) return sessions;
    const seen = new Set(sessions.map((session) => session.id));
    return [...sessions, ...olderSessions.filter((session) => !seen.has(session.id))];
  }, [sessions, olderSessions]);
  const taskLimit = sessionListParams(searchTerm, status, false, routineId).limit;
  const archiveLimit = sessionListParams(searchTerm, status, true, routineId).limit;
  const hasMoreTasks = taskMore ?? (taskList.pageFull || liveTasks.length >= taskLimit);
  const hasMoreArchive =
    scope === "archived" &&
    (archiveMore ?? (archivedList.pageFull || archivedTasks.length >= archiveLimit));
  // Imported agent sessions carry no routine, so a routine filter hides them
  // entirely; their paging has nothing left to page through.
  const hasMoreSessions = Boolean(sessionCursor) && !status && !routineFilter;

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
  // A project's record gives it one identity and one name, whatever root a
  // conversation ran in. Every root of every record is a way in, keyed the way
  // buckets key a cwd, and the first record wins on a duplicate root so the
  // heading never depends on iteration order. The records are this machine's
  // own filesystem (the API has no device column), which is also why
  // `seedProjects` files them under this machine.
  const projectByCwd = useMemo(() => {
    const byKey = new Map<string, PhoneProjectRecord>();
    for (const project of projects) {
      const name = project.name.trim();
      if (!name) continue;
      const roots = (project.roots ?? []).filter(
        (root) => bucketKeyFor(root) !== UNASSIGNED_PROJECT,
      );
      if (roots.length === 0) continue;
      const record: PhoneProjectRecord = { id: project.id, name, roots };
      for (const root of roots) {
        const key = bucketKeyFor(root);
        if (!byKey.has(key)) byKey.set(key, record);
      }
    }
    return byKey;
  }, [projects]);
  // Search and status views still display the stored order, but a reorder is
  // offered only where the whole bucket is shown; the archive scope has no
  // manual order at all. While a drag is live the dragged bucket draws the
  // in-flight order; the stored order is only written on release.
  const dragIds = drag?.ids;
  const dragBucketKey = drag?.bucketKey;
  const orders = useMemo(() => {
    if (scope !== "active") return undefined;
    if (!dragIds || !dragBucketKey) return taskOrder;
    return { ...taskOrder, [dragBucketKey]: dragIds };
  }, [scope, taskOrder, dragIds, dragBucketKey]);
  const buckets = useMemo(
    () =>
      phoneProjectBuckets(
        tasks,
        status || routineFilter ? [] : allSessions,
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
        (cwd) => projectByCwd.get(bucketKeyFor(cwd)),
        orders,
        localTitles,
      ),
    [
      tasks,
      allSessions,
      status,
      routineFilter,
      scope,
      selfDeviceId,
      locale,
      archivedCwds,
      projectByCwd,
      orders,
      localTitles,
    ],
  );
  // A project heading is where its cover lives, so a project with no row in the
  // loaded page is still drawn, with a count of 0 rather than omitted.
  //
  // Only from a trustworthy list: while a status filter is on, or the task feed
  // has failed or has not answered, "no rows" is not evidence the project is
  // empty, and seeding would replace "nothing matches" or a load error with a
  // wall of zero-count headings.
  const canSeed =
    scope === "active" && !status && !routineFilter && taskList.loaded && !taskList.error;
  const seeded = useMemo(
    () => seedProjects(buckets, canSeed ? projects : [], archivedCwds, tr("sessions.noProject")),
    [buckets, projects, canSeed, archivedCwds, tr],
  );
  const filtered = useMemo(() => filterProjectBuckets(seeded, query), [seeded, query]);
  // The project record the id names, and the bucket keys its roots file
  // under. A record can claim several roots and the list merges them into one
  // heading keyed by the first, so the keys are what "this project's
  // conversations" means — never the name, and never an id on a row (rows
  // carry a cwd, not a project id).
  const projectRecord = useMemo(
    () => (projectFilter ? (projects.find((project) => project.id === projectId) ?? null) : null),
    [projectFilter, projectId, projects],
  );
  const projectBucketKeys = useMemo(() => {
    if (!projectFilter) return null;
    const keys = new Set<string>();
    for (const root of projectRecord?.roots ?? []) {
      const key = bucketKeyFor(root);
      if (key !== UNASSIGNED_PROJECT) keys.add(key);
    }
    return keys;
  }, [projectFilter, projectRecord]);
  // The record's roots are what "this project" means; a bucket is kept only
  // when its key is one of them. Never a name match: two projects can share a
  // display name, and the id is the identity. An id with no record matches
  // nothing, and the chip's fallback label plus its clear control are what
  // make that state recoverable rather than silent.
  const narrowed = useMemo(
    () =>
      projectBucketKeys ? filtered.filter((bucket) => projectBucketKeys.has(bucket.key)) : filtered,
    [filtered, projectBucketKeys],
  );
  const listed = useMemo(
    () =>
      withPinnedBucket(
        narrowed,
        scope === "archived" ? EMPTY_IDS : pinnedIds,
        tr("sessions.pinned"),
        orders,
      ),
    [narrowed, pinnedIds, scope, tr, orders],
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
      {
        // The phone reads its machine headings as "where I was last", so the
        // most recently used one leads. The sidebar keeps its own order.
        order: shell === "page" ? "activity" : "sidebar",
        // An idle machine is a place to start work, so the plain phone list
        // gives it a heading. A search or a status filter narrows what is
        // listed, and "no chats" would then describe the filter, not the
        // machine — those views stay with the machines that have matches.
        includeEmptyDevices:
          shell === "page" &&
          !searching &&
          !status &&
          !routineFilter &&
          !projectFilter &&
          scope === "active" &&
          // A failed read has no "empty": the page says it could not load the
          // list, and a machine heading under that would claim the failure
          // was an absence of chats.
          taskList.loaded &&
          !taskList.error &&
          !(!status && sessionsFailed && listed.length === 0),
      },
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
  }, [
    listed,
    machines,
    selfDeviceId,
    sortMode,
    pinnedProjects,
    prefsTick,
    scope,
    shell,
    searching,
    status,
    routineFilter,
    taskList.loaded,
    taskList.error,
    sessionsFailed,
  ]);
  // The groups the default-fold rule has to decide about, in the order they
  // are drawn. A group with no conversations still has a heading and a count,
  // so it is a candidate too — it just can never be "the latest".
  const foldCandidates = useMemo(() => {
    const candidates: SessionListFoldCandidate[] = [];
    if (pinnedBucket) {
      candidates.push({
        stateKey: pinnedBucket.key,
        imported: false,
        pinned: true,
        lastActivityAt: pinnedBucket.lastActivityAt,
      });
    }
    for (const group of deviceGroups) {
      for (const bucket of group.buckets) {
        candidates.push({
          stateKey: `${group.id}::${bucket.key}`,
          imported: isImportedBucket(bucket.key),
          lastActivityAt: bucket.lastActivityAt,
        });
      }
    }
    return candidates;
  }, [pinnedBucket, deviceGroups]);
  const resolvedFolds = useMemo(
    () => resolveSessionListFolds(foldCandidates, folds),
    [foldCandidates, folds],
  );
  const foldSets = useMemo(() => {
    const collapsed = new Set<string>();
    const openImported = new Set<string>();
    for (const [key, open] of Object.entries(resolvedFolds)) {
      if (open) openImported.add(key);
      else collapsed.add(key);
    }
    return { collapsed, openImported };
  }, [resolvedFolds]);
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
  // Returning from the draft a machine's action opened: put focus back on that
  // same action once the headings are on screen. A group the return cannot
  // find (a filter arrived first) leaves focus alone rather than guessing.
  useEffect(() => {
    if (loading) return;
    const target = takeDeviceNewReturn();
    if (!target) return;
    const buttons = listRef.current?.querySelectorAll<HTMLElement>("[data-device-new]") ?? [];
    const button = Array.from(buttons).find((node) => node.dataset.deviceNew === target);
    button?.focus();
  }, [loading, deviceGroups]);
  const now = Date.now();
  const viewedIds = useMemo(() => new Set(getViewedSessionIds()), [viewTick]);
  // A reorder here would mean "reorder the current results", not the project:
  // the order is stored per bucket, so it is offered only where the bucket is
  // shown whole. The stored order still displays in the narrowed views.
  const canReorder =
    scope === "active" &&
    !searching &&
    !status &&
    !routineFilter &&
    !projectFilter &&
    !selectionMode;
  // "Nothing here" must describe the filter, not a page that ended: the same
  // empty state covers status, the archive and a routine or project narrowing.
  const filtering = Boolean(status) || scope === "archived" || routineFilter || projectFilter;
  // The narrowed list has read one page, not the project's whole history: with
  // pages still out, "no chats match" would describe the page, not the filter.
  const projectPagesRemain = projectFilter && (hasMoreTasks || hasMoreArchive || hasMoreSessions);
  const pendingQuery = query.trim() !== searchTerm;
  const archiveFailed = scope === "archived" && Boolean(archivedList.error);
  const archiveProjectsFailed = scope === "archived" && !archiveFailed && Boolean(taskList.error);
  const loadFailed = (Boolean(taskList.error) || archiveFailed) && listed.length === 0;
  // Imported sessions are a second index. Its failure is actionable on its own:
  // when it is the only feed with rows, the page must say what failed rather
  // than draw "no chats yet" over it.
  // Imported sessions carry no project, so a project narrowing never shows
  // them; their index failing is not this project's state.
  const importsFailed = !status && !routineFilter && !projectFilter && sessionsFailed;
  const importsFailedHard = importsFailed && !loading && listed.length === 0 && !loadFailed;
  // One retry for whatever this page is showing: the live list, and the archive
  // list when that scope is open. The button exists because the story promises
  // one (`KIN-CONTINUE-002`, step 6) and because waiting for an event to
  // repaint the list is not a next step a reader can take.
  const retryList = () => {
    void liveResources.refreshTaskList(sessionListParams(searchTerm, status, false, routineId));
    if (scope === "archived") {
      void liveResources.refreshTaskList(sessionListParams(searchTerm, status, true, routineId));
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

  /** The routine chip's clear control: back to the full list, same entry. */
  function changeRoutineFilter() {
    const nextParams = new URLSearchParams(params);
    nextParams.delete("routine");
    setParams(nextParams, { replace: true });
  }

  /** The project chip's clear control: back to the full list, same entry. */
  function changeProjectFilter() {
    const nextParams = new URLSearchParams(params);
    nextParams.delete("project");
    setParams(nextParams, { replace: true });
  }

  function foldIsOpen(stateKey: string, imported: boolean): boolean {
    return resolvedFolds[stateKey] ?? !imported;
  }

  function toggleFold(stateKey: string, imported: boolean) {
    setSessionFold(stateKey, !foldIsOpen(stateKey, imported));
    setFoldTick((n) => n + 1);
  }

  function toggleInstructions(projectId: string) {
    setOpenInstructions((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  function renderBucket(bucket: PhoneProjectBucket, stateKey: string) {
    const imported = isImportedBucket(bucket.key);
    // The reading half of the project cover moves into the list. Only this
    // machine's project record can answer a one-pager: a remote copy of the
    // same path, the synthetic pinned / no-project buckets and the imported
    // index have no cover here.
    const instructionsProject =
      bucket.cwd && !imported && bucketIsLocal(bucket)
        ? (projects.find((project) =>
            (project.roots ?? []).some((root) => bucketKeyFor(root) === bucket.key),
          ) ?? null)
        : null;
    // The launcher lands on the same draft "New conversation in …" opens, with
    // the edit request in the URL so even a new tab receives it.
    const draftQuery = listStateQuery(params, { cwd: bucket.cwd });
    const instructionsHref = instructionsProject
      ? `${DRAFT_PATH}${draftQuery}${draftQuery.includes("?") ? "&" : "?"}q=${encodeURIComponent(tr("projects.instructionsPrompt"))}`
      : null;
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
        onRename={renameRow}
        onArchive={archiveRow}
        onDelete={deleteRow}
        onRestore={restoreRow}
        scope={scope}
        query={query}
        canReorder={canReorder}
        draggingKey={drag?.key ?? null}
        dragOffsetY={drag?.offsetY ?? 0}
        onDragStart={startDrag}
        onDragMove={moveDrag}
        onDragEnd={endDrag}
        archived={scope === "archived"}
        onRestoreProject={
          scope === "archived" && bucketIsLocal(bucket) && archivedCwdFor(bucket.key, archivedCwds)
            ? () => {
                const stored = archivedCwdFor(bucket.key, archivedCwds);
                if (stored) unarchiveProjectRoots(bucket);
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
        onProjectMenu={() =>
          setProjectMenu({
            bucket,
            archived: scope === "archived",
            recordProjectId: instructionsProject?.id ?? null,
          })
        }
        onEditSummary={
          // The same record the row reads its work instructions from. A remote
          // copy of the path and a folder with no record have no One-Pager
          // here, so they get no pencil either.
          instructionsProject ? () => setSummaryProjectId(instructionsProject.id) : undefined
        }
        onEditRoots={
          // The folder list is the same local record's, so the folder button
          // follows the pencil's rule exactly: no record, no editor.
          instructionsProject ? () => setRootsProjectId(instructionsProject.id) : undefined
        }
        offline={offline}
        instructionsProjectId={instructionsProject?.id ?? null}
        instructions={instructionsProject ? projectInstructions[instructionsProject.id] : undefined}
        instructionsOpen={
          instructionsProject ? openInstructions.has(instructionsProject.id) : false
        }
        onToggleInstructions={() => {
          if (instructionsProject) toggleInstructions(instructionsProject.id);
        }}
        instructionsHref={instructionsHref}
        onReadInstructions={readProjectInstructions}
        onEditInstructions={(event) => {
          if (!instructionsHref) return;
          // Modifier clicks stay the browser's: the href itself carries the
          // cwd and the request, so a new tab opens the same draft.
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          runGuardedNavigation(() => {
            setDraftMachine("");
            setDraftCwd(bucket.cwd);
            phonePush(navigate, location, instructionsHref, {
              state: draftEntryState(listUrlFor(location.search)),
            });
          });
        }}
      />
    );
  }

  function openRow(row: PhoneSessionRow) {
    // The sidebar is on screen beside a dirty project or settings page, so a
    // row click is a departure from that page and asks it first. On the phone
    // the row's parent is the list; `phonePush` keeps that true.
    runGuardedNavigation(() => {
      rememberRowReturn(row.task?.id ?? row.session!.id);
      // An imported agent session is a surface of this list, not a departure
      // from it: open the sheet over the row so Back and the list's place stay
      // where the reader left them. The same sheet is what a deep-linked
      // `?agent=` opens.
      if (!row.task) {
        setAgentSheet(row.session!);
        return;
      }
      if (isTerminal(row.task.status)) markSessionViewed(row.task.id);
      const to = `/tasks/${encodeURIComponent(row.task.id)}${listStateQuery(params)}`;
      phonePush(navigate, location, to);
    });
  }

  /** Drop `agent` from the list's own URL, keeping its other state. */
  function clearAgentParam() {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("agent");
        return next;
      },
      { replace: true },
    );
  }

  /**
   * Close the sheet, whether it came from a row or the URL.
   *
   * A deep-linked sheet has a second entry under it: the sheet pushes its own
   * history entry above the list. Clearing `agent` with a replace right away
   * would rewrite that entry's state and leave the pushed one behind, so Back
   * would land on `?agent=` again and reopen what the reader closed. The
   * parameter is cleared on the entry the sheet gives back instead.
   */
  function closeAgentSheet(close?: AgentSessionSheetClose) {
    const urlAgent = (params.get("agent") ?? "").trim();
    setAgentSheet(null);
    if (!urlAgent) return;
    setAgentEntry(null);
    // A successful continue is not a dismissal on a Mac: the task it opens is
    // pushed above this list entry, and Back must return to the sheet the
    // reader left, still named by `?agent=`. The phone's close keeps its own
    // meaning — the list is the parent Back reaches, not the sheet.
    if (close?.reason === "attach" && !isPhoneLayout()) return;
    dismissedAgent.current = urlAgent;
    const sheetEntryIsCurrent = Boolean(
      (window.history.state as { kinSheet?: string } | null)?.kinSheet,
    );
    if (!sheetEntryIsCurrent) {
      // Closed by the browser's Back: the list's entry is already current.
      clearAgentParam();
      return;
    }
    let timer = 0;
    const clear = () => {
      window.removeEventListener("popstate", clear);
      window.clearTimeout(timer);
      clearAgentParam();
    };
    timer = window.setTimeout(() => {
      window.removeEventListener("popstate", clear);
      clearAgentParam();
    }, SHEET_ENTRY_RETURN_MS);
    window.addEventListener("popstate", clear);
  }

  /** The failed entry read's own retry: only that read runs again. */
  function retryAgentEntry() {
    dismissedAgent.current = null;
    setAgentEntryAttempt((n) => n + 1);
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

  function renameRow(row: PhoneSessionRow, title: string) {
    if (!row.task) return;
    // A rename is a local preference like a pin: this browser's name for the
    // conversation, written without the daemon. The lib returns the new map
    // even when storage refuses it, so the list still shows the new title for
    // this session and nothing here has to retry or toast.
    setLocalTitles(setLocalTaskTitle(row.task.id, title));
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
            ...sessionListParams(searchTerm, status, false, routineId),
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
            ...sessionListParams(searchTerm, status, true, routineId),
            before: oldest,
          });
          if (requestGeneration.current !== generation) return;
          setOlderArchivedTasks((current) => [...current, ...page]);
          setArchiveMore(page.length >= archiveLimit);
        } else {
          setArchiveMore(false);
        }
      }
      if (sessionCursorRef.current && !status && !routineFilter) {
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

  /**
   * The project row's heading narrows this list to that project (`?project=`),
   * the one surface the retired cover used to be. Like the filter chip, it is
   * a same-entry change: narrowing is not a departure, so it adds no history
   * layer and the chip's clear control puts the whole list back.
   *
   * A bucket with no local project record has no id to narrow by, and creating
   * a record just to navigate would write to the machine behind a click that
   * only meant "fold these rows". Those headings toggle instead — the same
   * action their chevron already offers.
   */
  function openProject(bucket: PhoneProjectBucket) {
    if (!bucket.cwd) return;
    if (!bucketIsLocal(bucket)) return;
    const known = projects.find((project) =>
      (project.roots ?? []).some((root) => bucketKeyFor(root) === bucket.key),
    );
    if (!known) return;
    const to = `${LIST_PATH}${listStateQuery(params, { project: known.id })}`;
    runGuardedNavigation(() => navigate(to, { replace: true }));
  }

  /** A project leaving the list is not one tap's worth of certainty: the hover
   *  control is 24px and its only reversal is the archived scope. */
  function archiveProjectConfirmed(bucket: PhoneProjectBucket) {
    if (!bucket.cwd) return;
    if (!bucketIsLocal(bucket)) return;
    if (!window.confirm(tr("nav.archiveConfirm", { project: bucket.label }))) return;
    for (const root of bucketRoots(bucket)) archiveProject(root);
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
        if (scope === "archived") unarchiveProjectRoots(bucket);
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

  /**
   * A chat aimed at one machine, chosen from that machine's heading.
   *
   * Both halves of the aim are written before the composer opens: the machine
   * id and a directory that machine can accept. The most recent directory is
   * the group's own history, so the action lands where the reader last worked
   * there; a machine that has never run anything falls back to its first
   * declared root, and only then to the empty path the composer already knows
   * how to ask about.
   */
  function newSessionOnDevice(group: PhoneDeviceGroup) {
    if (!group.online) return;
    let recent: PhoneProjectBucket | null = null;
    for (const bucket of group.buckets) {
      if (!bucket.cwd) continue;
      if (!recent || bucket.lastActivityAt > recent.lastActivityAt) recent = bucket;
    }
    const machine =
      machines.find((candidate) => candidate.id === group.id) ??
      (group.isSelf ? machines.find((candidate) => candidate.isSelf) : undefined);
    const cwd = recent?.cwd || machine?.roots[0] || "";
    runGuardedNavigation(() => {
      // This machine is stored as no machine, the same spelling every other
      // local entry point uses.
      rememberDeviceNewReturn(group.id || "__self__");
      setDraftMachine(group.isSelf ? "" : group.id.trim());
      setDraftCwd(cwd);
      const to = `${DRAFT_PATH}${listStateQuery(params, cwd ? { cwd } : {})}`;
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

  function updateDrag(next: SessionDrag | null) {
    dragRef.current = next;
    setDrag(next);
  }

  /** A hold became a drag. The ids are the whole bucket, not only the drawn
   *  rows: rows folded away by "show all" keep their place at the end. */
  function startDrag(bucketKey: string, key: string, ids: readonly string[]) {
    if (dragRef.current || !canReorder) return;
    dragOriginY.current = null;
    dragStartTop.current = rowTop(key);
    // The action strip and the drag cannot both own the row.
    setSwipeOpen(null);
    updateDrag({ bucketKey, key, ids: [...ids], offsetY: 0 });
  }

  /** The top of one drawn row's rect, transform included. */
  function rowTop(key: string): number | null {
    for (const element of sessionRows()) {
      if (element.dataset.sessionRow === key) return element.getBoundingClientRect().top;
    }
    return null;
  }

  /** The drawn rows' midpoints, in the order they currently sit on screen. */
  function rowMidpoints(ids: readonly string[]): { id: string; mid: number; height: number }[] {
    const wanted = new Set(ids);
    const out: { id: string; mid: number; height: number }[] = [];
    for (const element of sessionRows()) {
      const id = element.dataset.sessionRow;
      if (!id || !wanted.has(id)) continue;
      const rect = element.getBoundingClientRect();
      out.push({ id, mid: rect.top + rect.height / 2, height: rect.height });
    }
    return out.sort((a, b) => a.mid - b.mid);
  }

  function moveDrag(clientY: number) {
    const current = dragRef.current;
    if (!current) return;
    // The first move sets the origin, so the row does not jump by however far
    // the finger travelled during the hold.
    if (dragOriginY.current === null) dragOriginY.current = clientY;
    // The lifted row is not in the sequence; insert it after the last row
    // whose midpoint the finger has passed. Only this bucket's ids are asked
    // for, so a row can never be dropped into another project.
    const remaining = current.ids.filter((id) => id !== current.key);
    const rows = rowMidpoints(remaining);
    let at = 0;
    for (const row of rows) {
      if (clientY <= row.mid) break;
      at += 1;
    }
    const ids = [...remaining.slice(0, at), current.key, ...remaining.slice(at)];
    // `ids` draws the row in its new slot on the next render, so the transform
    // must cover only the distance between the finger and that slot; using the
    // finger's raw travel would move the row by both at once. The slot it sits
    // in now is its rect minus the transform already on it, shifted by the
    // rows this move jumps over.
    const from = current.ids.indexOf(current.key);
    const jumped = from < at ? rows.slice(from, at) : rows.slice(at, from);
    const shift = jumped.reduce((sum, row) => sum + row.height, 0) * (at < from ? -1 : 1);
    const startTop = dragStartTop.current ?? 0;
    const drawnTop = rowTop(current.key);
    const slotTop = (drawnTop === null ? startTop : drawnTop - current.offsetY) + shift;
    updateDrag({
      ...current,
      ids,
      offsetY: startTop + clientY - dragOriginY.current - slotTop,
    });
  }

  function endDrag(cancelled: boolean) {
    const current = dragRef.current;
    updateDrag(null);
    dragOriginY.current = null;
    dragStartTop.current = null;
    // A cancelled gesture puts the rows back; only a release is a decision.
    if (!current || cancelled) return;
    setBucketOrder(current.bucketKey, current.ids);
    setTaskOrder(getTaskOrder());
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
      routineFilter={routineFilter}
      onClearRoutine={changeRoutineFilter}
      projectFilter={projectFilter ? projectRecord?.name.trim() || projectId : ""}
      onClearProject={changeProjectFilter}
      onSortChange={(mode) => {
        setProjectSortMode(mode);
        setPrefsTick((n) => n + 1);
      }}
    />
  );

  const body = (
    <div ref={listRef} onKeyDown={onListKeyDown}>
      {urlAgentEntry?.failed && (
        <InlineAlert className="mx-4 mt-2">
          <div className="flex flex-wrap items-center gap-2">
            <span>{tr("sessions.agentEntryFailed")}</span>
            <Button variant="secondary" onClick={retryAgentEntry}>
              {tr("agentSession.historyRetry")}
            </Button>
          </div>
        </InlineAlert>
      )}

      {loading && <SessionListSkeleton shell={shell} label={tr("sessions.loading")} />}

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
        !projectPagesRemain &&
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
            // A machine list that failed cannot say which machines are online,
            // so it does not offer to start work on one. The Mac sidebar never
            // grows this action.
            onNewChat={
              shell === "page" && !machinesFailed ? () => newSessionOnDevice(group) : undefined
            }
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
              // The cover's summary and folder editors, moved to the row. Only
              // this machine's project record owns either one.
              ...(projectMenu.recordProjectId
                ? [
                    {
                      id: "edit-summary",
                      label: tr("nav.editSummary"),
                      onSelect: () => setSummaryProjectId(projectMenu.recordProjectId),
                    },
                    {
                      id: "edit-roots",
                      label: tr("projects.rootsEdit"),
                      onSelect: () => setRootsProjectId(projectMenu.recordProjectId),
                    },
                  ]
                : []),
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
              ...(!bucketIsLocal(projectMenu.bucket) || !projectMenu.recordProjectId
                ? []
                : [
                    {
                      id: "narrow-project",
                      label: tr("nav.openCover"),
                      onSelect: () => void openProject(projectMenu.bucket),
                    },
                  ]),
              ...(!bucketIsLocal(projectMenu.bucket)
                ? []
                : [
                    {
                      id: "archive",
                      label: projectMenu.archived
                        ? tr("nav.unarchiveProject")
                        : tr("nav.archiveProject"),
                      destructive: true,
                      onSelect: () => {
                        if (!projectMenu.bucket.cwd) return;
                        if (!bucketIsLocal(projectMenu.bucket)) return;
                        if (projectMenu.archived) unarchiveProjectRoots(projectMenu.bucket);
                        else archiveProjectConfirmed(projectMenu.bucket);
                      },
                    },
                  ]),
            ]
          : []
      }
    />
  );

  const summaryEditor = (
    <ProjectSummaryEditor
      open={summaryProjectId !== null}
      projectId={summaryProjectId}
      offline={offline}
      onClose={() => setSummaryProjectId(null)}
    />
  );

  // `onClose` clears the row at once. The sheet's own cleanup gives its
  // history entry back and only then runs the caller's `onCloseComplete`,
  // which is where a successful attach navigates: navigating from `onClose`
  // would strand that entry under the task it opened.
  const agentSessionSheet = (
    <AgentSessionSheet
      open={agentSheet !== null || urlAgentSession !== null}
      session={agentSheet ?? urlAgentSession}
      offline={offline}
      onClose={closeAgentSheet}
    />
  );

  const rootsEditor = (
    <ProjectRootsEditor
      open={rootsProjectId !== null}
      project={projects.find((project) => project.id === rootsProjectId) ?? null}
      offline={offline}
      machines={machines}
      machinesLoading={machinesLoading}
      onProjectChange={(updated) =>
        setProjects((current) =>
          current.map((project) => (project.id === updated.id ? updated : project)),
        )
      }
      onClose={() => setRootsProjectId(null)}
    />
  );

  if (shell === "sidebar") {
    return (
      <>
        {toolbar}
        <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">{body}</div>
        {projectSheet}
        {summaryEditor}
        {agentSessionSheet}
        {rootsEditor}
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
      {summaryEditor}
      {agentSessionSheet}
      {rootsEditor}
    </MobileScreen>
  );
}

/**
 * Project records can name one or more roots; the record is one heading.
 *
 * A project record is the local node's own (the API has no device id because
 * there is only one machine's filesystem behind it), which is why a seeded
 * heading is filed under this machine. The heading is keyed by the record's
 * first root — the same key its conversations use — so a second root never
 * draws a twin heading of its own. A record the reader archived locally is
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
    const roots: string[] = [];
    const rootKeys = new Set<string>();
    for (const root of project.roots ?? []) {
      const rootKey = bucketKeyFor(root);
      if (rootKey === UNASSIGNED_PROJECT || rootKeys.has(rootKey)) continue;
      rootKeys.add(rootKey);
      roots.push(root);
    }
    const primary = roots[0];
    if (primary === undefined) continue;
    const key = bucketKeyFor(primary);
    if (archived.has(key) || seen.has(key)) continue;
    seen.add(key);
    extra.push({
      key,
      label: project.name.trim() || tailOf(primary) || noProject,
      cwd: primary,
      roots,
      rows: [],
      lastActivityAt: project.last_active_at ?? 0,
      createdAt: project.created_at ?? 0,
      hasActiveTask: false,
    });
  }
  return [...buckets, ...extra];
}

/** Every root a heading stands for; a folder bucket is its own one root. */
function bucketRoots(bucket: PhoneProjectBucket): string[] {
  if (bucket.roots && bucket.roots.length > 0) return bucket.roots;
  return bucket.cwd ? [bucket.cwd] : [];
}

/**
 * Putting a merged heading back is one action.
 *
 * Archiving writes every root of the record, so restoring has to clear every
 * one of them: clearing only the first leaves the record's other roots filed,
 * and the heading comes back half hidden with no way to finish the job.
 */
function unarchiveProjectRoots(bucket: PhoneProjectBucket): void {
  for (const cwd of bucketRoots(bucket)) {
    unarchiveProject(cwd);
  }
}

function tailOf(cwd: string): string {
  return cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? "";
}

function DeviceSection({
  group,
  label,
  shell,
  renderBucket,
  onNewChat,
}: {
  group: PhoneDeviceGroup;
  label: string;
  shell: "sidebar" | "page";
  renderBucket: (bucket: PhoneProjectBucket, stateKey: string) => ReactNode;
  /** The phone's per-machine entry point; absent on the Mac sidebar and while
   *  the machine list cannot be trusted. */
  onNewChat?: () => void;
}) {
  const tr = useT();
  const sidebar = shell === "sidebar";
  const offlineReasonId = useId();
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
        {onNewChat ? (
          // Secondary, never the screen's primary action: the filled button
          // belongs to the composer, and the list's own entry point is the
          // header's "New chat". `aria-disabled` keeps the reason reachable —
          // a native disabled control cannot be focused or read.
          <Button
            variant="quiet"
            data-device-new={group.id || "__self__"}
            aria-label={tr("sessions.newChatOnDevice", { device: label })}
            aria-disabled={group.online ? undefined : true}
            aria-describedby={group.online ? undefined : offlineReasonId}
            onClick={() => {
              if (group.online) onNewChat();
            }}
            className={[
              "-my-1 h-11 w-11 flex-none items-center justify-center rounded-full p-0 text-kin-muted!",
              !group.online ? "cursor-not-allowed opacity-40 hover:bg-transparent!" : "",
            ].join(" ")}
          >
            <IconPlus size={16} strokeWidth={2} />
          </Button>
        ) : null}
      </div>
      {onNewChat && !group.online ? (
        <p id={offlineReasonId} className="px-4 pb-1 text-caption text-kin-muted">
          {tr("sessions.deviceOfflineNewChat")}
        </p>
      ) : null}
      {group.buckets.length === 0 ? (
        // A machine with no conversations is still a place to start one; it
        // gets its heading and the heading's action, not an invented project.
        <p className="px-4 pb-1 text-body text-kin-muted">{tr("sessions.deviceEmpty")}</p>
      ) : (
        // One indent step per level in the sidebar: machine at the rail's
        // gutter, its projects one step in, a project's rows one step in
        // again. `data-sidebar-indent` names the level so the hierarchy test
        // can read the step without measuring a layout jsdom does not have.
        <div
          data-sidebar-indent={sidebar ? "project" : undefined}
          className={sidebar ? "pl-4" : undefined}
        >
          {group.buckets.map((bucket) => renderBucket(bucket, `${group.id}::${bucket.key}`))}
        </div>
      )}
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

/**
 * The project cover's "工作方式", compressed for the conversation list
 * (KIN-PROJECT-003).
 *
 * The cover's block is a page card: a lead line, the body and a footnote. At
 * the cover's width that is fine; in a 240px sidebar or on a 390px phone it
 * spent the whole fold, and three expanded projects hid every conversation
 * below them. Inside the list the lead and the footnote are therefore gone —
 * the footnote stays only where it says something the body does not (the text
 * was cut at the 400-code-point bound, or this is the cached copy offline) —
 * the empty state is one line, and the body is clamped to two lines with the
 * title as its disclosure. The region's name carries the project's name: a
 * screen reader's landmark list otherwise shows several identical "工作方式"
 * regions with no way to tell which project each belongs to. It is a
 * `role="region"` div, not a `<section>`: the row is drawn inside the project
 * bucket's `<section>`, and a nested section stops the bucket from reading as
 * a leaf element to DOM queries and walkers.
 */
function ProjectInstructionsRow({
  projectName,
  loaded,
  loading,
  loadError,
  markdown,
  offline,
  expanded,
  onToggle,
  launcherHref,
  onLauncherClick,
  onRetry,
}: {
  projectName: string;
  loaded: boolean;
  loading: boolean;
  loadError: string | null;
  markdown: string;
  offline: boolean;
  /** Open state is the list's, keyed by project, so folding the project or
   *  leaving the list and coming back does not forget it. */
  expanded: boolean;
  onToggle: () => void;
  launcherHref: string | null;
  onLauncherClick: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  onRetry: () => void;
}) {
  const tr = useT();
  const bodyId = useId();
  const { text, truncated } = projectInstructions(markdown);
  const disabled = offline || launcherHref === null;
  const launcherLabel = text ? tr("projects.instructionsAsk") : tr("projects.instructionsWrite");
  const caption = [
    offline && text ? tr("projects.instructionsOffline") : "",
    truncated ? tr("projects.instructionsTruncated") : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      role="region"
      aria-label={`${tr("projects.instructionsTitle")} · ${projectName}`}
      className="rounded-lg bg-kin-panel px-3"
    >
      <div className="flex min-h-11 items-center justify-between gap-2">
        <Button
          variant="quiet"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
          className="-my-1 min-h-11 gap-1 px-0 text-caption font-medium uppercase tracking-label text-kin-secondary! hover:bg-transparent!"
        >
          {/* One nowrap row inside the button: Astryx's content span is a
              block, so a bare label + block SVG stacks the chevron under
              the text and the row grows by a line at 820. */}
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            <IconChevronDown
              size={12}
              strokeWidth={2.25}
              className={[
                "shrink-0 transition-transform",
                // Collapsed is a right-pointing ▸, the design's one-line
                // disclosure; open turns it down.
                expanded ? "" : "-rotate-90",
              ].join(" ")}
            />
            {tr("projects.instructionsTitle")}
          </span>
        </Button>
        {loadError && !expanded ? (
          <span className="min-w-0 flex-1 truncate text-right text-caption text-kin-muted">
            {loadError}
          </span>
        ) : null}
        {expanded && loaded && !loadError ? (
          disabled ? (
            <span className="flex-none text-caption text-kin-muted">{launcherLabel}</span>
          ) : (
            <a
              href={launcherHref}
              onClick={onLauncherClick}
              className="inline-flex min-h-11 flex-none items-center gap-1 text-caption text-kin-secondary hover:text-kin-text"
            >
              {launcherLabel}
              <span aria-hidden>→</span>
            </a>
          )
        ) : null}
      </div>

      {expanded ? (
        <div id={bodyId} className="pb-2">
          {loadError ? (
            <InlineAlert>
              <p>{loadError}</p>
              <Button variant="secondary" onClick={onRetry} className="mt-2 text-strong">
                {tr("common.retry")}
              </Button>
            </InlineAlert>
          ) : !loaded ? (
            loading ? (
              <SkeletonLine />
            ) : null
          ) : (
            <>
              {text ? (
                <p className="whitespace-pre-wrap text-caption leading-prose text-kin-text">
                  {text}
                </p>
              ) : (
                <p className="text-caption text-kin-muted">{tr("projects.instructionsEmpty")}</p>
              )}
              {caption ? <p className="mt-1 text-caption text-kin-muted">{caption}</p> : null}
            </>
          )}
        </div>
      ) : null}
    </div>
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
  onRename,
  onArchive,
  onDelete,
  onRestore,
  scope,
  query,
  canReorder,
  draggingKey,
  dragOffsetY,
  onDragStart,
  onDragMove,
  onDragEnd,
  archived,
  local,
  hasStoredOrder,
  onRestoreOrder,
  onRestoreProject,
  onOpenProject,
  onNewSession,
  onArchiveProject,
  onProjectMenu,
  onEditSummary,
  onEditRoots,
  instructionsProjectId,
  instructions,
  instructionsOpen,
  onToggleInstructions,
  instructionsHref,
  onReadInstructions,
  onEditInstructions,
  offline,
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
  onRename: (row: PhoneSessionRow, title: string) => void;
  onArchive: (row: PhoneSessionRow) => void;
  onDelete: (row: PhoneSessionRow) => void;
  onRestore: (row: PhoneSessionRow) => void;
  scope: SessionScopeFilter;
  /** Alt+↑/↓ moves a row here; each row carries the hint while it does. A
   *  completed hold also lifts the row into a drag. */
  canReorder: boolean;
  draggingKey: string | null;
  dragOffsetY: number;
  onDragStart: (bucketKey: string, key: string, ids: readonly string[]) => void;
  onDragMove: (clientY: number) => void;
  onDragEnd: (cancelled: boolean) => void;
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
  /** Edit the one-line summary here; absent when the bucket has no local
   *  project record (the One-Pager lives on this machine only). */
  onEditSummary?: () => void;
  /** Edit the working folders here; absent for the same reason as the
   *  summary pencil — the ordered `roots` list is the local record's. */
  onEditRoots?: () => void;
  /** The local project record this bucket is, or null when it has none. */
  instructionsProjectId: string | null;
  instructions?: ProjectInstructionsEntry;
  /** Whether this project's 「工作方式」 disclosure is open. */
  instructionsOpen: boolean;
  onToggleInstructions: () => void;
  /** The edit draft, or null when the bucket has no record to read. */
  instructionsHref: string | null;
  onReadInstructions: (projectId: string) => void;
  onEditInstructions: (event: ReactMouseEvent<HTMLAnchorElement>) => void;
  offline: boolean;
}) {
  const tr = useT();
  const headingRef = useRef<HTMLButtonElement | null>(null);
  // The reset control unmounts together with the order it clears, so focus
  // moves back to the bucket heading rather than falling to <body>.
  const restoreOrder = () => {
    onRestoreOrder();
    window.requestAnimationFrame(() => headingRef.current?.focus());
  };
  const rows = showAll ? bucket.rows : bucket.rows.slice(0, ROWS_BEFORE_SHOW_ALL);
  const hidden = bucket.rows.length - rows.length;
  const showAllLabel =
    hidden > 0
      ? tr("sessions.showAll", { count: String(bucket.rows.length) })
      : tr("sessions.showLess");
  const imported = isImportedBucket(bucket.key);
  const realProject = Boolean(bucket.cwd) && !imported;
  // The heading narrows the list to this project's conversations. That needs
  // the local project record: its id is what `?project=` names. A remote copy
  // of a path, and a folder with no record, fold the project instead of
  // offering a control that would do nothing.
  const openable = realProject && local && instructionsProjectId !== null;
  const heading = imported
    ? tr("sessions.imported", { count: String(bucket.rows.length) })
    : bucket.label;
  const gutter = shell === "sidebar" ? "px-2" : "px-4";
  // The same pointer rule the rows follow: the Mac's mouse gets the compact
  // header gap, a finger keeps the roomier one it has always had.
  const dense = shell === "sidebar" && !coarse;
  const pinnedProject = pinnedProjects.some((cwd) => bucketKeyFor(cwd) === bucket.key);
  // Reading is lazy: a collapsed bucket issues no one-pager read. Re-expanding
  // paints the cached answer while this refresh is out.
  useEffect(() => {
    if (collapsed || !instructionsProjectId) return;
    onReadInstructions(instructionsProjectId);
  }, [collapsed, instructionsProjectId, onReadInstructions]);

  return (
    <section className="pb-1">
      <div
        className={`group/proj relative flex items-center gap-0.5 ${gutter} pb-1 ${
          dense ? "pt-2" : "pt-4"
        }`}
      >
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
            and the design system has no row primitive. It carries the shared
            unscoped `data-kin-hit-row` marker so the floating approval yields
            to it exactly as it yields to a conversation row: the strip once
            covered this heading and ate the tap meant to fold the group. */}
        <button
          ref={headingRef}
          type="button"
          data-kin-hit-row=""
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

            Fine pointers get the same 24px, tooltip-backed icon the real
            projects' hover strip uses. A phone has no tooltip, and a bare ↻
            beside “Pinned” reads as “refresh”, so coarse pointers get the
            refresh-plus-label shape of the archived project's Restore button.
          */
          coarse ? (
            <Button
              variant="secondary"
              title={tr("nav.restoreTimeOrder")}
              aria-label={tr("nav.restoreTimeOrder")}
              onClick={restoreOrder}
              className="h-11 flex-none items-center gap-1.5 rounded-lg px-2.5 text-caption font-medium"
            >
              <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                <IconRefresh size={13} />
                <span>{tr("sessions.restore")}</span>
              </span>
            </Button>
          ) : (
            <ProjectIconButton label={tr("nav.restoreTimeOrder")} onClick={restoreOrder}>
              <IconRefresh size={12} />
            </ProjectIconButton>
          )
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
              label={openable ? tr("nav.openCover") : tr("nav.openCoverLocalOnly")}
              onClick={onOpenProject}
              disabled={!openable}
            >
              <IconFile size={12} />
            </ProjectIconButton>
            {onEditSummary ? (
              // The summary editor lives here now that the cover is gone.
              <ProjectIconButton label={tr("nav.editSummary")} onClick={onEditSummary}>
                <IconPencil size={12} />
              </ProjectIconButton>
            ) : null}
            {onEditRoots ? (
              // Its folder editor sits beside it: the same record, the same
              // rule for when this machine owns the list.
              <ProjectIconButton label={tr("projects.rootsEdit")} onClick={onEditRoots}>
                <IconFolderOpen size={12} />
              </ProjectIconButton>
            ) : null}
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

      {/* The conversation block is one step in from the project block. A mouse
          takes the scale's 12px step; a finger keeps 16px so the level stays
          as legible as it was on touch. 12, not 8: the row's own leading
          avatar and gutter spend 56px before its title, so an 8px block step
          would land the title exactly on the project label and flatten the
          three levels #26 exists to keep apart. */}
      {!collapsed && (
        <div
          data-sidebar-indent={shell === "sidebar" ? "session" : undefined}
          className={shell === "sidebar" ? (dense ? "pl-3" : "pl-4") : undefined}
        >
          {instructionsProjectId ? (
            <div className="pb-2">
              <ProjectInstructionsRow
                projectName={bucket.label}
                loaded={instructions?.loaded ?? false}
                loading={instructions?.loading ?? true}
                loadError={instructions?.failed ? tr("projects.summaryLoadFailed") : null}
                markdown={instructions?.markdown ?? ""}
                offline={offline}
                expanded={instructionsOpen}
                onToggle={onToggleInstructions}
                launcherHref={instructionsHref}
                onLauncherClick={onEditInstructions}
                onRetry={() => onReadInstructions(instructionsProjectId)}
              />
            </div>
          ) : null}
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
              onRename={(title) => onRename(row, title)}
              onArchive={() => onArchive(row)}
              onDelete={() => onDelete(row)}
              onRestore={() => onRestore(row)}
              scope={scope}
              query={query}
              reorderHint={canReorder && !imported}
              // Imported sessions are an index, not a project order, and the
              // stored order is never applied there; so no handle either.
              reorder={
                canReorder && !imported
                  ? {
                      onStart: () =>
                        onDragStart(
                          bucket.key,
                          row.key,
                          bucket.rows.map((member) => member.key),
                        ),
                      onMove: onDragMove,
                      onEnd: onDragEnd,
                    }
                  : undefined
              }
              dragging={draggingKey === row.key}
              dragOffsetY={draggingKey === row.key ? dragOffsetY : 0}
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
