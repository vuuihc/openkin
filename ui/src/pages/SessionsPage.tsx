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
import { isSessionViewed, markSessionViewed, sessionStatusDotClass } from "../lib/sessionViewed";
import { useT } from "../i18n/react";

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

  return (
    <div className="flex-1 min-h-0 overflow-y-auto kin-scroll">
      {loading && (
        <p className="px-4 py-10 text-center text-strong text-kin-muted">
          {tr("sessions.loading")}
        </p>
      )}

      {!loading && groups.length === 0 && (
        <div className="px-6 py-16 text-center">
          <p className="text-subtitle font-medium text-kin-text">{tr("sessions.empty")}</p>
          <p className="mt-1.5 text-strong leading-prose text-kin-muted">
            {tr("sessions.emptyHint")}
          </p>
        </div>
      )}

      {!loading &&
        groups.map((device) => (
          <section key={device.id || "self"}>
            {machineLabels && (
              <h2 className="sticky top-0 z-[2] flex items-center gap-1.5 px-4 pb-1.5 pt-4 text-body font-semibold text-kin-muted bg-[var(--kin-page)]">
                <span
                  className={`h-[7px] w-[7px] flex-none rounded-full ${
                    device.online ? "bg-kin-green" : "bg-kin-muted"
                  }`}
                />
                {device.isSelf ? tr("nav.thisMachine") : device.label}
              </h2>
            )}

            {groupSessions(deviceRows(device), now).map((bucket) => (
              <div key={bucket.key}>
                {/*
                  Not sticky: the machine heading above already is, and two
                  sticky headings in one scroll fight over the same line.
                */}
                <h3 className="px-4 pb-1 pt-4 text-caption font-semibold uppercase tracking-label text-kin-muted">
                  {tr(BUCKET_LABEL_KEY[bucket.key])}
                </h3>
                {bucket.rows.map((row) => (
                  <SessionRow
                    key={row.key}
                    row={row}
                    now={now}
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
              </div>
            ))}
          </section>
        ))}

      {!loading && sessionsFailed && groups.length > 0 && (
        <p className="px-4 py-6 text-center text-body text-kin-muted">
          {tr("sessions.agentSessionsFailed")}
        </p>
      )}

      <div className="h-6" />
    </div>
  );
}

type RowProps = { row: Row; now: number; onOpen: () => void };

function SessionRow({ row, now, onOpen }: RowProps) {
  const tr = useT();
  // The sidebar's dot, on the phone: green means a run finished and has not
  // been opened, blue means it is still going. Null (nothing drawn) is the
  // common case, so the list is not a field of dots.
  const dot = row.task
    ? sessionStatusDotClass(row.task.status, isSessionViewed(row.task.id))
    : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full min-h-16 items-start gap-2.5 border-b border-[var(--kin-hairline)] px-4 py-2.5 text-left active:bg-[var(--kin-fill)]"
    >
      <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-lg bg-kin-blue/15 text-subtitle font-bold text-kin-blue-ink">
        {initial(agentDisplayName(row.task?.agent ?? row.session!.agent_id))}
      </span>

      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-subtitle font-medium leading-ui">
          {row.task
            ? row.task.title.trim() || displayUserPrompt(row.task.prompt) || tr("sessions.untitled")
            : displayAgentSessionTitle(row.session!, tr("sessions.untitled"))}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-body text-kin-muted">
          <span className="truncate">{row.project}</span>
          <span className="opacity-50">·</span>
          <span className="flex-none">{formatRelativeTime(row.at, now)}</span>
        </span>
      </span>

      <span className="flex flex-none items-center gap-1.5 pt-0.5">
        {dot && <span className={`h-1.5 w-1.5 flex-none rounded-full ${dot}`} aria-hidden />}
        {row.task ? (
          <StatusPill status={row.task.status} />
        ) : (
          <span className="inline-flex h-5 items-center rounded-lg bg-[var(--kin-fill)] px-2 text-caption font-semibold text-kin-muted">
            {agentDisplayName(row.session!.agent_id)}
          </span>
        )}
      </span>
    </button>
  );
}

function StatusPill({ status }: { status: string }) {
  const tr = useT();
  const view = taskCardStatusView(status);
  const tone =
    view.tone === "approval"
      ? "bg-kin-orange/15 text-kin-orange-ink"
      : view.tone === "completed"
        ? "bg-kin-green/15 text-kin-green-ink"
        : view.tone === "failed"
          ? "bg-kin-red/15 text-kin-red-ink"
          : view.tone === "running"
            ? "bg-kin-blue/15 text-kin-blue-ink"
            : "bg-[var(--kin-fill)] text-kin-muted";
  return (
    <span
      className={`inline-flex h-5 items-center rounded-lg px-2 text-caption font-semibold ${tone}`}
    >
      {tr(view.labelKey)}
    </span>
  );
}
