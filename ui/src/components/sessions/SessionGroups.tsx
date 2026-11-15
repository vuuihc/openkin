/* eslint-disable kin/no-raw-button -- The project heading controls, the project
   hover actions, the draft row and the empty-state retry button are moved
   verbatim out of SessionList. They are pre-existing controls, not a new
   surface, and restyling them onto the shared Button here would be a visual
   change this extraction must not make. */
import type { ReactNode } from "react";
import type { Project } from "../../api/client";
import { useT } from "../../i18n/react";
import type { Machine } from "../../lib/devices";
import {
  bucketKeyFor,
  isImportedBucket,
  pinnedRowDeviceName,
  UNASSIGNED_PROJECT,
  type PhoneDeviceGroup,
  type PhoneProjectBucket,
  type PhoneSessionRow,
} from "../../lib/phoneSessionBuckets";
import { toggleProjectPinned } from "../../lib/projectSidebar";
import HighlightedText from "../HighlightedText";
import {
  IconAlert,
  IconArchive,
  IconChevronDown,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconMachine,
  IconMore,
  IconPin,
  IconPlus,
  IconRefresh,
  IconSessions,
} from "../icons";
import { MobileEmpty } from "../mobile/MobileList";
import type { SessionScopeFilter } from "../ui/SessionFilters";
import SessionRow from "./SessionRow";

/**
 * The conversation list's grouping: machine → project → row, the draft row,
 * and the empty/error bodies.
 *
 * `SessionList` still owns every handler and all list state; `DeviceSection`
 * receives its `renderBucket` closure exactly as before, because that closure
 * is where the list's selection, fold and navigation state meets a bucket.
 */

const ROWS_BEFORE_SHOW_ALL = 5;

/**
 * Project records can name one or more roots; each root is a heading.
 *
 * A project record is the local node's own (the API has no device id because
 * there is only one machine's filesystem behind it), which is why a seeded
 * heading is filed under this machine. A root the reader archived locally is
 * skipped: the daemon still calls the project active, and re-adding it here
 * would resurrect the heading the archive was meant to hide.
 */
export function seedProjects(
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

export function DeviceSection({
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

export function DraftRow({
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

export type ProjectBucketProps = {
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
  onLongPress: (row: PhoneSessionRow) => void;
  swipeOpen: string | null;
  onSwipeOpenChange: (open: string | null) => void;
  pinnedIds: ReadonlySet<string>;
  pinnedProjects: readonly string[];
  onPin: (row: PhoneSessionRow) => void;
  onArchive: (row: PhoneSessionRow) => void;
  onDelete: (row: PhoneSessionRow) => void;
  onRestore: (row: PhoneSessionRow) => void;
  scope: SessionScopeFilter;
  archived: boolean;
  /** This bucket's rows run on this machine, so the local project record —
   *  cover, pin, archive — describes it. */
  local: boolean;
  onRestoreProject?: () => void;
  onOpenProject: () => void;
  onNewSession: () => void;
  onArchiveProject: () => void;
  onProjectMenu: () => void;
};

export function ProjectBucket({
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
  onLongPress,
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
  archived,
  local,
  onRestoreProject,
  onOpenProject,
  onNewSession,
  onArchiveProject,
  onProjectMenu,
}: ProjectBucketProps) {
  const tr = useT();
  const rows = showAll ? bucket.rows : bucket.rows.slice(0, ROWS_BEFORE_SHOW_ALL);
  const hidden = bucket.rows.length - rows.length;
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
      <div className={`group/proj flex items-center gap-0.5 ${gutter} pb-1 pt-4`}>
        <button
          type="button"
          onClick={() => {
            if (canToggle) onToggle();
          }}
          aria-expanded={!collapsed}
          aria-disabled={canToggle ? undefined : true}
          tabIndex={canToggle ? undefined : -1}
          aria-label={`${tr(collapsed ? "nav.expandProject" : "nav.collapseProject")} ${heading}`}
          className={[
            "kin-row-press flex flex-none items-center justify-center rounded-lg text-kin-muted",
            coarse ? "min-h-11 w-11" : "min-h-9 w-7",
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
        </button>
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
          <button
            type="button"
            onClick={onRestoreProject}
            aria-label={`${tr("sessions.restore")} ${bucket.label}`}
            className="flex min-h-11 flex-none items-center gap-1.5 rounded-lg bg-[var(--kin-fill)] px-2.5 text-caption font-medium text-kin-text"
          >
            <IconRefresh size={13} />
            {tr("sessions.restore")}
          </button>
        ) : null}
        {realProject && !onRestoreProject && !coarse ? (
          <div className="flex flex-none items-center">
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
          </div>
        ) : null}
        {realProject && coarse ? (
          <button
            type="button"
            title={tr("nav.projectActions")}
            aria-label={tr("nav.projectActions")}
            aria-haspopup="dialog"
            onClick={onProjectMenu}
            className="flex h-11 w-11 flex-none items-center justify-center rounded-full text-kin-muted active:bg-[var(--kin-fill)]"
          >
            <IconMore size={18} />
          </button>
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
              onLongPress={() => onLongPress(row)}
              swipeOpen={swipeOpen === row.key}
              onSwipeOpenChange={(open) => onSwipeOpenChange(open ? row.key : null)}
              pinned={row.task ? pinnedIds.has(row.task.id) : false}
              onPin={() => onPin(row)}
              onArchive={() => onArchive(row)}
              onDelete={() => onDelete(row)}
              onRestore={() => onRestore(row)}
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
              <span className="w-2 flex-none" aria-hidden />
              <span className="min-w-0 truncate">
                {hidden > 0
                  ? tr("sessions.showAll", { count: String(bucket.rows.length) })
                  : tr("sessions.showLess")}
              </span>
            </button>
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
            : "text-kin-muted opacity-0 hover:bg-[var(--kin-fill-strong)] hover:text-kin-text focus:opacity-100 group-hover/proj:opacity-100",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

/**
 * The one body the list shows when it has no rows to draw.
 *
 * The parent decides which `kind` applies — the conditions overlap, so
 * choosing between them in one place is what keeps the states exclusive — and
 * this file owns only their copy and the one Retry action.
 */
export type SessionListEmptyKind = "loading" | "pending" | "load-error" | "imports-error" | "empty";

export type SessionListEmptyView = {
  icon: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
};

export function SessionListEmpty({
  kind,
  emptyView,
  onRetry,
}: {
  kind: SessionListEmptyKind;
  emptyView: SessionListEmptyView;
  onRetry: () => void;
}) {
  const tr = useT();
  if (kind === "loading") {
    return (
      <p className="px-4 py-10 text-center text-strong text-kin-muted">{tr("sessions.loading")}</p>
    );
  }
  if (kind === "pending") {
    return (
      <p className="px-4 py-10 text-center text-strong text-kin-muted">
        {tr("sessions.searching")}
      </p>
    );
  }
  if (kind === "load-error" || kind === "imports-error") {
    const imports = kind === "imports-error";
    return (
      <MobileEmpty
        icon={<IconAlert size={30} />}
        title={tr(imports ? "sessions.agentSessionsLoadError" : "sessions.loadError")}
        hint={tr(imports ? "sessions.agentSessionsLoadErrorHint" : "sessions.loadErrorHint")}
        action={
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg bg-kin-text px-4 py-2 text-strong font-medium text-kin-bg"
          >
            {tr("common.retry")}
          </button>
        }
      />
    );
  }
  return <MobileEmpty icon={emptyView.icon} title={emptyView.title} hint={emptyView.hint} />;
}
