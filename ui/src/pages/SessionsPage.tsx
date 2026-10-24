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
import { useT } from "../i18n/react";

/**
 * The phone's session list — machine heading, then sessions, in one scroll.
 *
 * The desktop sidebar keeps the full machine → project → session tree because
 * it has the width for it. A phone does not. The grouping survives by making
 * the machine a section heading and demoting the project to a line of metadata
 * on each row, so several sessions fit on one screen without opening a single
 * disclosure triangle.
 *
 * Reached from the 会话 tab. Desktop never links here.
 */

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
  // Running work first, then newest — the two questions someone opens this
  // screen to answer.
  return rows.sort(
    (a, b) => Number(b.active) - Number(a.active) || b.at - a.at || a.key.localeCompare(b.key),
  );
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
          <p className="mt-1.5 text-strong leading-relaxed text-kin-muted">
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

            {deviceRows(device).map((row) => (
              <button
                key={row.key}
                type="button"
                onClick={() =>
                  navigate(
                    row.task
                      ? `/tasks/${encodeURIComponent(row.task.id)}`
                      : `/agent-sessions/${encodeURIComponent(row.session!.id)}`,
                  )
                }
                className="flex w-full min-h-[62px] items-start gap-2.5 border-b border-[var(--kin-hairline)] px-4 py-2.5 text-left active:bg-[var(--kin-fill)]"
              >
                <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] bg-kin-blue-soft text-subtitle font-bold text-[#6cb2ff]">
                  {initial(agentDisplayName(row.task?.agent ?? row.session!.agent_id))}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 text-subtitle font-medium leading-[1.32]">
                    {row.task
                      ? row.task.title.trim() ||
                        displayUserPrompt(row.task.prompt) ||
                        tr("sessions.untitled")
                      : displayAgentSessionTitle(row.session!, tr("sessions.untitled"))}
                  </span>
                  <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-body text-kin-muted">
                    <span className="truncate">{row.project}</span>
                    <span className="opacity-50">·</span>
                    <span className="flex-none">{formatRelativeTime(row.at)}</span>
                  </span>
                </span>

                <span className="flex-none pt-0.5">
                  {row.task ? (
                    <StatusPill status={row.task.status} />
                  ) : (
                    <span className="inline-flex h-5 items-center rounded-[10px] bg-[var(--kin-fill)] px-2 text-caption font-semibold text-kin-muted">
                      {agentDisplayName(row.session!.agent_id)}
                    </span>
                  )}
                </span>
              </button>
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

function StatusPill({ status }: { status: string }) {
  const tr = useT();
  const view = taskCardStatusView(status);
  const tone =
    view.tone === "approval"
      ? "bg-kin-orange-soft text-kin-orange"
      : view.tone === "completed"
        ? "bg-[rgba(48,209,88,.13)] text-kin-green"
        : view.tone === "failed"
          ? "bg-[rgba(255,69,58,.12)] text-kin-red"
          : view.tone === "running"
            ? "bg-kin-blue-soft text-[#6cb2ff]"
            : "bg-[var(--kin-fill)] text-kin-muted";
  return (
    <span
      className={`inline-flex h-5 items-center rounded-[10px] px-2 text-caption font-semibold ${tone}`}
    >
      {tr(view.labelKey)}
    </span>
  );
}
