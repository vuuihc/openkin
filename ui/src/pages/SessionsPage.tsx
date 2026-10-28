import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { isTerminal, listAgentSessions, type AgentSession, type Task } from "../api/client";
import { useTaskList } from "../api/useLiveResources";
import { useMachines } from "../hooks/useMachines";
import {
  groupByDevice,
  sessionsForProject,
  showMachineLabels,
  ONLY_THIS_MACHINE,
  type DeviceGroup,
} from "../lib/deviceSidebar";
import { displayAgentSessionTitle } from "../lib/agentSessionTitle";
import { agentDisplayName } from "../lib/agentMention";
import { displayUserPrompt } from "../lib/attachments";
import { taskCardStatusView } from "../lib/taskCardStatus";
import { formatRelativeTime } from "../lib/relativeTime";
import { groupSessions, type SessionBucketKey } from "../lib/sessionBuckets";
import {
  getViewedSessionIds,
  markSessionViewed,
  sessionStatusDotClass,
} from "../lib/sessionViewed";
import { useT } from "../i18n/react";
import { MobileCard, MobileEmpty, MobileRow, MobileScreen, MobileSection } from "../components/mobile/MobileList";
import { IconSessions } from "../components/icons";

/**
 * The phone's session list — a few sections of rows, in one scroll.
 *
 * The desktop sidebar keeps the full machine → project → session tree because
 * it has the width for it. A phone does not. The grouping survives by making
 * the machine a section heading and demoting the project to a line of metadata
 * on each row, so several sessions fit on one screen without opening a single
 * disclosure triangle.
 *
 * The sections are time (`sessionBuckets`), because a flat list of a hundred
 * rows is what this screen was: measured at 7218px of content in a 747px
 * viewport, with nothing to tell you where today ended. "In progress" comes
 * first because it is the one thing on this screen that wants an answer.
 *
 * Reached from the 会话 tab. Desktop never links here.
 */

/** The section headings' text. Order comes from `SESSION_BUCKET_ORDER`. */
const BUCKET_LABEL_KEY: Record<SessionBucketKey, string> = {
  active: "sessions.groupActive",
  today: "sessions.groupToday",
  week: "sessions.groupWeek",
  older: "sessions.groupOlder",
};

type Row = {
  key: string;
  at: number;
  active: boolean;
  project: string;
  task?: Task;
  session?: AgentSession;
};

function deviceRows(device: DeviceGroup): Row[] {
  const rows: Row[] = [];
  for (const project of device.projects) {
    for (const task of project.items) {
      rows.push({
        key: task.id,
        // Same clock the sidebar sorts by: a finished task reads by when it
        // finished, a running one by when it started.
        at: task.finished_at ?? task.started_at ?? task.created_at ?? 0,
        active: !isTerminal(task.status),
        project: project.label,
        task,
      });
    }
    for (const session of sessionsForProject(device.sessions, project)) {
      rows.push({
        key: session.id,
        at: session.updated_at ?? 0,
        active: false,
        project: project.label,
        session,
      });
    }
  }
  // Newest first inside a section. Running work used to be sorted to the top
  // here; that is a section now (`sessionBuckets`), which is the same intent
  // expressed once instead of fighting the time order of every other row.
  return rows.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

function initial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0]!.toUpperCase() : "·";
}

export default function SessionsPage() {
  const tr = useT();
  const navigate = useNavigate();
  const taskList = useTaskList({ limit: 100 });
  const { machines, loading: machinesLoading } = useMachines();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [sessionsFailed, setSessionsFailed] = useState(false);

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

  const machineList = machines.length > 0 ? machines : ONLY_THIS_MACHINE;
  const groups = useMemo(
    () => groupByDevice(taskList.data, sessions, machineList, null, false, machinesLoading),
    [taskList.data, sessions, machineList, machinesLoading],
  );
  const machineLabels = showMachineLabels(groups, []);
  const loading = !taskList.loaded;
  // One clock for the whole render, so a section boundary cannot land between
  // two rows of the same list — and so every row says "when" against the same
  // now. No subscription to the viewed set: this page unmounts on the way into
  // a session, so it re-reads on the way back anyway (the sidebar needs the
  // live subscription; it never unmounts).
  const now = Date.now();
  // Read once per render, not once per row: `isSessionViewed` re-parses the
  // whole stored map, and this list holds up to a hundred rows on every live
  // update.
  const viewedIds = new Set(getViewedSessionIds());

  return (
    <MobileScreen className="mx-auto w-full max-w-2xl">
      {loading && (
        <p className="px-4 py-10 text-center text-strong text-kin-muted">
          {tr("sessions.loading")}
        </p>
      )}

      {!loading && groups.length === 0 && (
        <MobileEmpty
          icon={<IconSessions size={30} />}
          title={tr("sessions.empty")}
          hint={tr("sessions.emptyHint")}
        />
      )}

      {!loading &&
        groups.map((device) => (
          <section key={device.id || "self"}>
            {machineLabels && (
              <h2 className="flex items-center gap-1.5 px-4 pb-0.5 pt-5 text-caption font-semibold text-kin-muted">
                <span
                  className={`h-[7px] w-[7px] flex-none rounded-full ${
                    device.online ? "bg-kin-green" : "bg-kin-muted"
                  }`}
                />
                {/* `device.label` falls back to the raw machine id, so this is
                    the one string on the page that can be arbitrarily long.
                    It is a flex child: `min-w-0` + `truncate` is what keeps it
                    inside the scroll root instead of widening it. */}
                <span className="min-w-0 truncate">
                  {device.isSelf ? tr("nav.thisMachine") : device.label}
                </span>
              </h2>
            )}

            {groupSessions(deviceRows(device), now).map((bucket) => (
              <MobileSection key={bucket.key} title={tr(BUCKET_LABEL_KEY[bucket.key])}>
                <MobileCard>
                  {bucket.rows.map((row) => (
                    <SessionRow
                      key={row.key}
                      row={row}
                      now={now}
                      viewedIds={viewedIds}
                      onOpen={() => {
                        if (!row.task) {
                          navigate(`/agent-sessions/${encodeURIComponent(row.session!.id)}`);
                          return;
                        }
                        // Clearing the dot on the way in is what the sidebar
                        // does; without it the same row keeps saying "new" every
                        // time the list is reopened.
                        if (isTerminal(row.task.status)) markSessionViewed(row.task.id);
                        navigate(`/tasks/${encodeURIComponent(row.task.id)}`);
                      }}
                    />
                  ))}
                </MobileCard>
              </MobileSection>
            ))}
          </section>
        ))}

      {!loading && sessionsFailed && groups.length > 0 && (
        <p className="px-4 py-6 text-center text-body text-kin-muted">
          {tr("sessions.agentSessionsFailed")}
        </p>
      )}
    </MobileScreen>
  );
}

type RowProps = {
  row: Row;
  now: number;
  viewedIds: ReadonlySet<string>;
  onOpen: () => void;
};

function SessionRow({ row, now, viewedIds, onOpen }: RowProps) {
  const tr = useT();
  // The sidebar's dot, on the phone: green means a run finished and has not
  // been opened, blue means it is still going. Null (nothing drawn) is the
  // common case, so the list is not a field of dots.
  const dot = row.task ? sessionStatusDotClass(row.task.status, viewedIds.has(row.task.id)) : null;
  const agent = agentDisplayName(row.task?.agent ?? row.session!.agent_id);
  return (
    <MobileRow
      onClick={onOpen}
      leading={
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-kin-blue/15 text-subtitle font-bold text-kin-blue-ink">
          {initial(agent)}
        </span>
      }
      title={
        row.task
          ? row.task.title.trim() || displayUserPrompt(row.task.prompt) || tr("sessions.untitled")
          : displayAgentSessionTitle(row.session!, tr("sessions.untitled"))
      }
      detail={`${row.project} · ${formatRelativeTime(row.at, now)}`}
      trailing={
        <span className="flex items-center gap-1.5">
          {dot && <span className={`h-1.5 w-1.5 flex-none rounded-full ${dot}`} aria-hidden />}
          {row.task ? (
            <StatusText status={row.task.status} />
          ) : (
            <span className="text-caption text-kin-muted">{agent}</span>
          )}
        </span>
      }
    />
  );
}

/**
 * The row's status word.
 *
 * The state marker is the dot beside it (`sessionStatusDotClass`), which also
 * knows whether a finished run has been opened yet. Drawing a second dot here
 * was two markers for one fact — the first screenshot of this list had a
 * "• • 已完成" on every finished row. The word stays muted: a completed run
 * should not compete with the title it produced.
 */
function StatusText({ status }: { status: string }) {
  const tr = useT();
  const view = taskCardStatusView(status);
  return <span className="text-caption text-kin-muted">{tr(view.labelKey)}</span>;
}
