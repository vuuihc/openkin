import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { isTerminal, listAgentSessions, type AgentSession } from "../api/client";
import { useTaskList } from "../api/useLiveResources";
import { useMachines } from "../hooks/useMachines";
import { agentAvatarMeta, agentDisplayName } from "../lib/agentMention";
import { formatRelativeTime } from "../lib/relativeTime";
import {
  filterProjectBuckets,
  phoneProjectBuckets,
  type PhoneProjectBucket,
  type PhoneSessionRow,
} from "../lib/phoneSessionBuckets";
import {
  getViewedSessionIds,
  markSessionViewed,
  sessionStatusDotClass,
} from "../lib/sessionViewed";
import { taskCardStatusView } from "../lib/taskCardStatus";
import { getArchivedProjects, subscribeProjectSidebar } from "../lib/projectSidebar";
import { useLocale, useT } from "../i18n/react";
import { MobileEmpty, MobileScreen } from "../components/mobile/MobileList";
import SessionsSearch from "../components/mobile/SessionsSearch";
import { IconChevronDown, IconFolder, IconFolderOpen, IconMachine, IconSessions } from "../components/icons";

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
 * Search is local to the loaded rows and lives in `?q=`, so the header and the
 * list cannot disagree and a reload keeps the query. A server-side search over
 * the whole library is a later step if the 100-row cap starts to matter.
 */

const ROWS_BEFORE_SHOW_ALL = 5;

export default function SessionsPage() {
  const tr = useT();
  // The memo below bakes copy into the buckets ("No project", "Untitled"), so
  // it has to rebuild on a locale switch — `tr` is a stable function and would
  // never invalidate it.
  const { locale } = useLocale();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const query = params.get("q") ?? "";
  const taskList = useTaskList({ limit: 100 });
  const { machines, loading: machinesLoading } = useMachines();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [sessionsFailed, setSessionsFailed] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // Archiving a project from the drawer has to empty this list too, and the
  // archive lives in sidebar prefs: subscribe rather than read once.
  const [prefsTick, setPrefsTick] = useState(0);
  useEffect(() => subscribeProjectSidebar(() => setPrefsTick((n) => n + 1)), []);

  useEffect(() => {
    let cancelled = false;
    const read = () => {
      listAgentSessions({ limit: 100 })
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
  }, []);

  const selfDeviceId = (machines.find((machine) => machine.isSelf)?.id ?? "").trim();
  // `prefsTick` is the invalidation: it changes when the drawer archives or
  // restores a project, and the memo below has to rebuild then.
  const archivedCwds = useMemo(() => getArchivedProjects(), [prefsTick]);
  const buckets = useMemo(
    () =>
      phoneProjectBuckets(
        taskList.data,
        sessions,
        selfDeviceId,
        {
          untitled: tr("sessions.untitled"),
          noProject: tr("sessions.noProject"),
        },
        archivedCwds,
      ),
    [taskList.data, sessions, selfDeviceId, locale, archivedCwds],
  );
  const filtered = useMemo(() => filterProjectBuckets(buckets, query), [buckets, query]);
  const loading = !taskList.loaded || machinesLoading;
  // One clock for the whole render, so two rows never disagree about "now".
  const now = Date.now();
  // Read once per render, not once per row: `isSessionViewed` re-parses the
  // whole stored map, and this list holds up to a hundred rows on every live
  // update.
  const viewedIds = new Set(getViewedSessionIds());
  const searching = query.trim() !== "";

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

      {!loading && buckets.length === 0 && (
        <MobileEmpty
          icon={<IconSessions size={30} />}
          title={tr("sessions.empty")}
          hint={tr("sessions.emptyHint")}
        />
      )}

      {!loading && buckets.length > 0 && filtered.length === 0 && (
        <MobileEmpty
          icon={<IconSessions size={30} />}
          title={tr("sessions.searchEmpty", { query: query.trim() })}
        />
      )}

      {!loading &&
        filtered.map((bucket) => (
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
          />
        ))}

      {!loading && sessionsFailed && buckets.length > 0 && (
        <p className="px-4 py-6 text-center text-body text-kin-muted">
          {tr("sessions.agentSessionsFailed")}
        </p>
      )}
    </MobileScreen>
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
}: {
  bucket: PhoneProjectBucket;
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
            {bucket.label}
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
}: {
  row: PhoneSessionRow;
  now: number;
  viewedIds: ReadonlySet<string>;
  onOpen: () => void;
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
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      className="kin-row-press flex min-h-11 w-full items-center gap-2.5 px-4 py-2.5 text-left"
    >
      <span className="flex w-2 flex-none justify-center">
        {dot ? <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden /> : null}
      </span>
      <span
        className={`flex h-5 w-5 flex-none items-center justify-center rounded-full text-micro font-semibold ${avatar.className}`}
        title={agentDisplayName(row.agentId)}
      >
        {avatar.initials}
      </span>
      <span className="min-w-0 flex-1 truncate text-subtitle font-medium leading-ui text-kin-text">
        {row.title}
      </span>
      {row.remote && (
        <span
          className="flex-none text-kin-muted"
          title={tr("machine.remote")}
          aria-hidden
        >
          <IconMachine size={12} />
        </span>
      )}
      <span className="flex-none text-caption leading-ui text-kin-muted tabular-nums">
        {formatRelativeTime(row.at, now)}
      </span>
    </button>
  );
}
