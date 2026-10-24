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
  getPinnedProjects,
  groupByProject,
  sortProjectGroups,
  type ProjectGroup,
  type ProjectSidebarPrefs,
} from "./projectSidebar";

export type DeviceGroup = {
  /** Machine id. Empty only for a daemon that has not named its own machine. */
  id: string;
  /** The machine's own name, or the raw id when it is one this console cannot
   *  describe (a machine that was revoked, say). The UI phrases "this machine". */
  label: string;
  isSelf: boolean;
  online: boolean;
  projects: ProjectGroup[];
  /** Imported agent sessions on this machine, matched to a project by cwd. */
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

export function projectLabelForSession(session: AgentSession): string {
  return (
    session.project_label ||
    (session.cwd ? session.cwd.split("/").filter(Boolean).pop() : "") ||
    "Unassigned"
  );
}

export function sessionsForProject(sessions: AgentSession[], group: ProjectGroup): AgentSession[] {
  return sessions.filter((session) => projectKey(session.cwd) === projectKey(group.cwd));
}

/**
 * Add a project row for every imported session whose cwd has no tasks yet.
 *
 * Without this an agent session imported from a project nobody has given Kin
 * work in yet would be invisible: projects otherwise exist only because a task
 * named them. The merged rows are sorted back into place, so an imported
 * session touched a minute ago is not buried under older task rows.
 */
export function mergeExternalProjectGroups(
  groups: ProjectGroup[],
  sessions: AgentSession[],
  prefs?: ProjectSidebarPrefs | null,
  onlyArchived = false,
): ProjectGroup[] {
  const out = [...groups];
  const known = new Set(out.map((group) => projectKey(group.cwd)));
  // Sort ranks pins from the stored list, not from `group.pinned`, so a row
  // that leaves this false sorts to the top and draws an unlit pin button that
  // unpins it when clicked.
  const pinned = new Set((prefs?.pinned ?? getPinnedProjects()).map((cwd) => normCwd(cwd)));
  for (const session of sessions) {
    const key = projectKey(session.cwd);
    if (known.has(key)) continue;
    known.add(key);
    out.push({
      label: projectLabelForSession(session),
      cwd: session.cwd,
      items: [],
      pinned: pinned.has(key),
      archived: onlyArchived,
      lastInteractedAt: session.updated_at,
      createdAt: session.first_seen_at,
      hasActiveTask: false,
    });
  }
  return sortProjectGroups(out, prefs, onlyArchived);
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

    const projects = mergeExternalProjectGroups(
      groupByProject(deviceTasks, prefs, false, onlyArchived),
      deviceSessions,
      prefs,
      onlyArchived,
    );
    if (projects.length === 0) continue;

    const machine = known.get(id);
    let lastActivityAt = 0;
    for (const project of projects) {
      if (project.lastInteractedAt > lastActivityAt) lastActivityAt = project.lastInteractedAt;
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

/**
 * Whether the tree needs to name its machines.
 *
 * One machine is usually the obvious one — the console runs on it, so a heading
 * saying so is noise. Two exceptions: more than one machine (the whole point of
 * the heading), and a console whose only work runs *somewhere else* (a Hub whose
 * sessions all ran on a paired laptop). In the second case the tree is no longer
 * "obviously this machine", and staying silent hides the one fact the grouping
 * exists to show.
 */
export function showMachineLabels(groups: DeviceGroup[], archivedGroups: DeviceGroup[]): boolean {
  const all = [...groups, ...archivedGroups];
  if (new Set(all.map((group) => group.id)).size > 1) return true;
  return all.length > 0 && all.every((group) => !group.isSelf);
}
