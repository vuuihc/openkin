import type { Machine } from "./devices";

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

/** Which machine record a remembered value names. */
export function machineForRoutineDevice(machines: Machine[], id: string): Machine | undefined {
  if (!id || id === THIS_MACHINE) return machines.find((m) => m.isSelf);
  return machines.find((m) => m.id === id);
}
