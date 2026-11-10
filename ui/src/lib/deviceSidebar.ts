/**
 * Sidebar grouping: machine → project → session.
 *
 * A console can be talking to a Hub with several machines behind it, so the
 * first question about a session is which machine runs it — that is the thing a
 * person chose when they started it, and the thing that decides whether it can
 * run at all right now. Project is the second question, session the third.
 *
 * Machines come from the same list the composer picks a target from, so a
 * session's group header and the machine it was sent to can never disagree.
 */

import type { AgentSession, Task } from "../api/client";
import type { Machine } from "./devices";
import {
  getArchivedProjects,
  groupByProject,
  type ProjectGroup,
  type ProjectSidebarPrefs,
  sortProjectGroups,
} from "./projectSidebar";
import { projectLabel } from "./paths";

export type DeviceGroup = {
  /** Machine id. Empty only for a daemon that has not named its own machine. */
  id: string;
  /** The machine's own name, or the raw id when it is one this console cannot
   *  describe (a machine that was revoked, say). The UI phrases "this machine". */
  label: string;
  isSelf: boolean;
  online: boolean;
  projects: ProjectGroup[];
  /** Imported agent sessions on this machine, listed as one device-end group.
   *  They are not projects: an import has no status, pin or archive of its own. */
  sessions: AgentSession[];
  /** Tasks + imported sessions, for the group's count badge. */
  count: number;
  lastActivityAt: number;
};

/** The machine list before it has loaded. Everything on screen is on this
 *  machine, and no machine has a name yet. Callers pair this with
 *  `unknownIsSelf` so a console whose device list is still in flight does not
 *  file every remote session under a raw id and then rename it a moment later. */
export const ONLY_THIS_MACHINE: Machine[] = [
  { id: "", label: "", isSelf: true, online: true, roots: [], agents: [] },
];

/** Project identity. Two paths that differ only by case or trailing slash are
 *  the same project, and a session with no cwd at all is still a project row. */
export function projectKey(cwd: string): string {
  return normCwd(cwd) || "__unassigned__";
}

function normCwd(cwd: string): string {
  return (cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * The machines a session can have run on, keyed the way sessions name them.
 *
 * An empty `executing_device_id` is not "unknown": it is this machine. Tasks
 * created before a Hub existed, and every task a standalone daemon runs, name
 * no device because there was only ever one.
 */
function deviceIdOf(value: string | undefined, selfId: string): string {
  return (value ?? "").trim() || selfId;
}

function bucket<T>(map: Map<string, T[]>, key: string, item: T): void {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}

/**
 * Group a console's sessions under the machine that runs them, then under their
 * project.
 *
 * @param onlyArchived When true, produce the archived-projects view instead:
 *                     only archived projects, with only the imported sessions
 *                     that live in them.
 * @param unknownIsSelf When true, a task naming a machine this list does not
 *                     describe is grouped under this machine. That is right
 *                     while the device list is still loading — the alternative
 *                     is a heading labelled with a raw id, drawn offline, that
 *                     renames itself one render later. Once the list is in, an
 *                     id nobody knows means a machine that was revoked, and
 *                     naming it is the honest thing to do.
 * Machines holding nothing are left out — a paired laptop that has never been
 * given work is a choice in the composer, not an empty heading in the sidebar.
 */
export function groupByDevice(
  tasks: Task[],
  sessions: AgentSession[],
  machines: Machine[],
  prefs?: ProjectSidebarPrefs | null,
  onlyArchived = false,
  unknownIsSelf = false,
): DeviceGroup[] {
  const self = machines.find((machine) => machine.isSelf);
  const selfId = (self?.id ?? "").trim();
  const known = new Map(machines.map((machine) => [machine.id, machine]));
  // Keys the list actually describes. A machine with no id of its own (the
  // synthetic single-machine list) describes nothing by id.
  const described = new Set([...known.keys()].filter(Boolean));

  const tasksByDevice = new Map<string, Task[]>();
  for (const task of tasks) {
    const id = deviceIdOf(task.executing_device_id, selfId);
    bucket(tasksByDevice, unknownIsSelf && !described.has(id) ? selfId : id, task);
  }
  const sessionsByDevice = new Map<string, AgentSession[]>();
  for (const session of sessions) {
    const id = deviceIdOf(session.device_id, selfId);
    bucket(sessionsByDevice, unknownIsSelf && !described.has(id) ? selfId : id, session);
  }

  const archivedKeys = new Set(
    (prefs?.archived ?? getArchivedProjects()).map((cwd) => normCwd(cwd)),
  );

  const ids = new Set<string>([...tasksByDevice.keys(), ...sessionsByDevice.keys()]);

  const groups: DeviceGroup[] = [];
  for (const id of ids) {
    const deviceTasks = tasksByDevice.get(id) ?? [];
    const deviceSessions = (sessionsByDevice.get(id) ?? []).filter((session) =>
      onlyArchived
        ? archivedKeys.has(normCwd(session.cwd))
        : !archivedKeys.has(normCwd(session.cwd)),
    );

    // Imported sessions are deliberately not merged into project groups: they
    // are drawn as one device-end group, so an import never invents a project
    // and never borrows a project's pin or archive state.
    let projects = groupByProject(deviceTasks, prefs, false, onlyArchived);
    if (onlyArchived) {
      // An archived project whose tasks all fell outside the loaded page still
      // has to be drawn: its heading is where Restore lives. An imported
      // session naming the cwd is the only evidence left that it exists — the
      // same evidence the old merged rows used — and only a cwd already in the
      // archive list is seeded, so an import never invents an archived project.
      const seen = new Set(projects.map((project) => normCwd(project.cwd)));
      for (const session of deviceSessions) {
        const key = normCwd(session.cwd);
        if (!key || seen.has(key) || !archivedKeys.has(key)) continue;
        seen.add(key);
        projects.push({
          cwd: session.cwd,
          // The provider's own project name, when it has one, is the name the
          // reader learned; the cwd's tail is only the fallback it always was.
          label: session.project_label?.trim() || projectLabel(session.cwd),
          items: [],
          pinned: false,
          archived: true,
          lastInteractedAt: session.updated_at ?? 0,
          createdAt: 0,
          hasActiveTask: false,
        });
      }
      if (projects.length > 0) projects = sortProjectGroups(projects, prefs, true);
    }
    if (projects.length === 0 && deviceSessions.length === 0) continue;

    const machine = known.get(id);
    let lastActivityAt = 0;
    for (const project of projects) {
      if (project.lastInteractedAt > lastActivityAt) lastActivityAt = project.lastInteractedAt;
    }
    for (const session of deviceSessions) {
      if ((session.updated_at ?? 0) > lastActivityAt) lastActivityAt = session.updated_at;
    }
    groups.push({
      id,
      label: machine?.label || id,
      isSelf: id === selfId,
      online: machine ? machine.online : false,
      projects,
      sessions: deviceSessions,
      // What the section will actually list. Counting the device's whole task
      // bucket would put a number over a section that does not show that many
      // rows — the archived pass sees the same tasks, filtered the other way.
      count: projects.reduce((n, project) => n + project.items.length, 0) + deviceSessions.length,
      lastActivityAt,
    });
  }

  // This machine first (it is where the console runs), then the machines that
  // can take work now, most recently busy first. A machine nobody can reach
  // stays on the list — a sleeping laptop is offline, not gone.
  groups.sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    const recent = b.lastActivityAt - a.lastActivityAt;
    if (recent !== 0) return recent;
    return a.label.localeCompare(b.label);
  });
  return groups;
}
