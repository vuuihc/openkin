import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { isTerminal, listAgentSessions, type AgentSession, type Task } from "../api/client";
import { useTaskList } from "../api/useLiveResources";
import { useMachines } from "../hooks/useMachines";
import { agentAvatarMeta, agentDisplayName } from "../lib/agentMention";
import { formatRelativeTime } from "../lib/relativeTime";
import {
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
import { archiveProject, getArchivedProjects, subscribeProjectSidebar } from "../lib/projectSidebar";
import { useLocale, useT } from "../i18n/react";
import { MobileEmpty, MobileScreen } from "../components/mobile/MobileList";
import HighlightedText from "../components/HighlightedText";
import SessionsSearch from "../components/mobile/SessionsSearch";
import {
  IconAlert,
  IconArchive,
  IconCheck,
  IconChevronDown,
  IconFolder,
  IconFolderOpen,
  IconMachine,
  IconPin,
  IconSessions,
} from "../components/icons";
import SwipeReveal from "../components/mobile/SwipeReveal";

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
  // The memo below bakes copy into the buckets ("No project", "Untitled"), so
  // it has to rebuild on a locale switch — `tr` is a stable function and would
  // never invalidate it.
  const { locale } = useLocale();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const query = params.get("q") ?? "";
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

  const taskList = useTaskList(sessionListParams(searchTerm));
  const { machines, loading: machinesLoading } = useMachines();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
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
  // One swipe-revealed row at a time, the same rule the message actions use.
  const [swipeOpen, setSwipeOpen] = useState<string | null>(null);
  // Archiving a project from the drawer has to empty this list too, and the
  // archive lives in sidebar prefs: subscribe rather than read once.
  const [prefsTick, setPrefsTick] = useState(0);
  useEffect(() => subscribeProjectSidebar(() => setPrefsTick((n) => n + 1)), []);

  useEffect(() => {
    let cancelled = false;
    // A new query is a new question: the previous answer's failure notice must
    // not sit over rows it never described.
    setSessionsFailed(false);
    const read = () => {
      listAgentSessions(sessionListParams(searchTerm))
        .then((rows) => {
          if (cancelled) return;
          setSessions(rows);
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
  const tasks = taskList.loaded ? taskList.data : lastLoadedTasks.current;
  // `prefsTick` is the invalidation: it changes when the drawer archives or
  // restores a project, and the memo below has to rebuild then.
  const archivedCwds = useMemo(() => getArchivedProjects(), [prefsTick]);
  const buckets = useMemo(
    () =>
      phoneProjectBuckets(
        tasks,
        sessions,
        selfDeviceId,
        {
          untitled: tr("sessions.untitled"),
          noProject: tr("sessions.noProject"),
        },
        archivedCwds,
      ),
    [tasks, sessions, selfDeviceId, locale, archivedCwds],
  );
  const filtered = useMemo(() => filterProjectBuckets(buckets, query), [buckets, query]);
  // Pinned rows leave their project buckets and lead the list.
  const listed = useMemo(
    () => withPinnedBucket(filtered, pinnedIds, tr("sessions.pinned")),
    [filtered, pinnedIds, tr],
  );
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
  // The field is ahead of the request: until the server answers the settled
  // term, an empty list means "not answered yet", not "no matches".
  const pendingQuery = query.trim() !== searchTerm;
  const loadFailed = Boolean(taskList.error) && tasks.length === 0;

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
    if (!row.task) return; // imported sessions cannot be pinned or archived
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
            icon={<IconSessions size={30} />}
            title={
              // With the server doing the matching, "no rows" after a search
              // is the search's answer; the empty-library copy would be a lie.
              searching ? tr("sessions.searchEmpty", { query: query.trim() }) : tr("sessions.empty")
            }
            hint={searching ? undefined : tr("sessions.emptyHint")}
          />
        )}

      {/* Multi-select toolbar, in the slot the heading would occupy: select
          all + count on the left, the batch actions on the right. Long-press
          any row to enter this mode (the reference's gesture); the same two
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
            <button
              type="button"
              onClick={pinSelected}
              disabled={selectedIds.size === 0}
              className="flex min-h-10 items-center gap-1.5 rounded-lg bg-[var(--kin-fill)] px-3 text-body font-medium text-kin-text disabled:opacity-40"
            >
              <IconPin size={14} />
              {selectedIds.size > 0 &&
              Array.from(selectedIds).every((id) => pinnedIds.has(id))
                ? tr("sessions.unpin")
                : tr("sessions.pin")}
            </button>
            <button
              type="button"
              onClick={archiveSelected}
              disabled={selectedIds.size === 0}
              className="flex min-h-10 items-center gap-1.5 rounded-lg bg-[var(--kin-fill)] px-3 text-body font-medium text-kin-text disabled:opacity-40"
            >
              <IconArchive size={14} />
              {tr("sessions.archive")}
            </button>
            <button
              type="button"
              onClick={exitSelection}
              className="flex min-h-10 items-center rounded-lg px-3 text-body font-medium text-kin-muted hover:text-kin-text"
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
            selectedIds={selectedIds}
            onToggleSelect={toggleSelected}
            onLongPress={enterSelection}
            swipeOpen={swipeOpen}
            onSwipeOpenChange={setSwipeOpen}
            onPin={pinRow}
            onArchive={archiveRow}
            query={query}
          />
        ))}

      {!loading && sessionsFailed && buckets.length > 0 && (
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
  selectedIds,
  onToggleSelect,
  onLongPress,
  swipeOpen,
  onSwipeOpenChange,
  onPin,
  onArchive,
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
  selectedIds: ReadonlySet<string>;
  onToggleSelect: (key: string) => void;
  onLongPress: (row: PhoneSessionRow) => void;
  swipeOpen: string | null;
  onSwipeOpenChange: (open: string | null) => void;
  onPin: (row: PhoneSessionRow) => void;
  onArchive: (row: PhoneSessionRow) => void;
}) {
  const tr = useT();
  const rows = showAll ? bucket.rows : bucket.rows.slice(0, ROWS_BEFORE_SHOW_ALL);
  const hidden = bucket.rows.length - rows.length;

  return (
    <section className="pb-1">
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
        className="kin-row-press flex min-h-11 w-full items-center gap-1.5 px-4 pb-1 pt-4 text-left"
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
              selected={row.task ? selectedIds.has(row.task.id) : false}
              onToggleSelect={() => onToggleSelect(row.key)}
              onLongPress={() => onLongPress(row)}
              swipeOpen={swipeOpen === row.key}
              onSwipeOpenChange={(open) => onSwipeOpenChange(open ? row.key : null)}
              onPin={() => onPin(row)}
              onArchive={() => onArchive(row)}
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
  selected,
  onToggleSelect,
  onLongPress,
  swipeOpen,
  onSwipeOpenChange,
  onPin,
  onArchive,
  query,
}: {
  row: PhoneSessionRow;
  /** The live search text, marked in the title. */
  query: string;
  now: number;
  viewedIds: ReadonlySet<string>;
  onOpen: () => void;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onLongPress: () => void;
  swipeOpen: boolean;
  onSwipeOpenChange: (open: boolean) => void;
  onPin: () => void;
  onArchive: () => void;
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
          // they are not selectable.
          if (row.task) onToggleSelect();
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
          if (row.task) onToggleSelect();
        }
      }}
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

  if (selectionMode || !row.task) return rowButton;

  // Swipe left to reveal the same two batch actions the multi-select owns.
  // The long-press that enters multi-select lives in the swipe wrapper too:
  // once a drag captures the pointer, the row's own button stops seeing
  // moves, and a timer it can no longer cancel would fire behind the user's
  // back (or the cancel would never fire at all).
  return (
    <SwipeReveal
      open={swipeOpen}
      onOpenChange={onSwipeOpenChange}
      onLongPress={onLongPress}
      actions={
      <>
        <button
          type="button"
          onClick={onPin}
          aria-label={tr("sessions.pin")}
          title={tr("sessions.pin")}
          className="flex w-[76px] flex-none flex-col items-center justify-center gap-1 bg-[var(--kin-fill-strong)] text-caption font-medium text-kin-text"
        >
          <IconPin size={16} />
          {tr("sessions.pin")}
        </button>
        <button
          type="button"
          onClick={onArchive}
          aria-label={tr("sessions.archive")}
          title={tr("sessions.archive")}
          className="flex w-[76px] flex-none flex-col items-center justify-center gap-1 bg-kin-orange/15 text-caption font-medium text-kin-orange-ink"
        >
          <IconArchive size={16} />
          {tr("sessions.archive")}
        </button>
      </>
    }>
      {rowButton}
    </SwipeReveal>
  );
}
