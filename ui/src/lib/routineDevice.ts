import { pathWithin, type Machine } from "./devices";

const KEY = "kin_routines_device";

/** "self" is a real choice, not an absent one: the page remembers that the
 *  reader picked this machine, so the next open does not silently move to a
 *  laptop again. */
export const THIS_MACHINE = "self";

export function readRoutineDevice(): string {
  try {
    return localStorage.getItem(KEY) || "";
  } catch {
    return "";
  }
}

export function writeRoutineDevice(id: string): void {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    // A console that cannot write preferences still works; the choice just
    // does not survive the tab.
  }
}

/**
 * The machine the Routines page opens on.
 *
 * Routines belong to machines, so the page must start on one. A remembered
 * choice wins while that machine still exists; a remembered machine that was
 * revoked is not a choice. With nothing remembered the page opens on the first
 * machine that is not this one, because on a phone "this one" is the Hub — it
 * holds no routines and never will — and an empty page is exactly the defect
 * the machine selection exists to fix. A console with no other machine, like a
 * desktop attached to a node, opens on itself.
 */
export function resolveRoutineDevice(machines: Machine[], saved: string): string {
  const wanted = saved.trim();
  if (wanted === THIS_MACHINE) return THIS_MACHINE;
  if (wanted && machines.some((m) => m.id === wanted && !m.isSelf)) return wanted;
  const other = machines.find((m) => !m.isSelf && m.online) ?? machines.find((m) => !m.isSelf);
  return other ? other.id : THIS_MACHINE;
}

/**
 * The machine a project's routines live on.
 *
 * A project is a Hub-side record keyed by a folder; a routine is a machine
 * fact stored with the folder it runs in. The machine list is the map between
 * them — a node reports the directories it works in — so the project's cwd
 * names its owner. When two nodes report the same folder, the remembered
 * Routines choice breaks the tie, then an online machine, then list order:
 * the same preference the Routines page applies.
 *
 * No node naming the folder means this machine. A console with no nodes is a
 * desktop attached to its own daemon, and a project created by path there is a
 * local record; empty means "this machine" wherever routine requests go.
 */
export function routineDeviceForProject(machines: Machine[], cwd: string, saved: string): string {
  const path = cwd.trim();
  if (!path) return "";
  const owners = machines.filter(
    (m) => !m.isSelf && m.roots.some((root) => pathWithin(root, path)),
  );
  if (owners.length === 0) return "";
  const remembered = owners.find((m) => m.id === saved.trim());
  if (remembered) return remembered.id;
  const online = owners.find((m) => m.online);
  return (online ?? owners[0]).id;
}

/**
 * The machine the sidebar's routine badge counts.
 *
 * It has to be the machine the Routines page would open on, or the badge and
 * the page would disagree about which routines exist — on a phone, where this
 * machine is the Hub, the badge would sit at 0 while a laptop has unread runs.
 * While the list is still arriving there is no answer yet: null tells the
 * caller to wait instead of counting this machine and correcting itself a
 * moment later. A list that failed to load confirms nothing, so a remembered
 * machine stands — the same rule the page applies before it writes.
 */
export function routineDeviceForBadge(
  machines: Machine[],
  saved: string,
  loading: boolean,
  failed: boolean,
): string | null {
  if (loading) return null;
  return failed ? saved : resolveRoutineDevice(machines, saved);
}

/** Which machine record a remembered value names. */
export function machineForRoutineDevice(machines: Machine[], id: string): Machine | undefined {
  if (!id || id === THIS_MACHINE) return machines.find((m) => m.isSelf);
  return machines.find((m) => m.id === id);
}
