import type { AgentInfo, DeviceInfo } from "../api/client";

/**
 * One machine the console can send work to.
 *
 * Two sources answer different halves of the question: `/api/version` says which
 * machine this console is talking to, `/api/devices` says which other machines
 * have dialled in. Neither alone is enough — a Hub with no Nodes still has one
 * machine, and the device list is not guaranteed to include the daemon itself.
 */
export type Machine = {
  id: string;
  /** The machine's own name. The UI decides how to phrase "this machine". */
  label: string;
  isSelf: boolean;
  online: boolean;
  /** Directories the machine works in; empty means it declared none. */
  roots: string[];
  agents: MachineAgent[];
};

/** One agent runtime on one machine, as that machine reported it. */
export type MachineAgent = {
  id: string;
  available: boolean;
  reason?: string;
  isDefault?: boolean;
};

export type SelfIdentity = { id: string; name: string };

/**
 * The machines to offer, this one first, then the ones that can take work now.
 * Machines that are switched off stay on the list: a sleeping laptop should read
 * as "offline", not as "gone", or the user cannot tell the difference between a
 * machine that is down and one that was never paired.
 */
export function machineList(
  devices: DeviceInfo[],
  self: SelfIdentity,
  localAgents: AgentInfo[],
): Machine[] {
  const here: Machine = {
    id: (self.id ?? "").trim(),
    label: (self.name ?? "").trim(),
    isSelf: true,
    online: true,
    roots: [],
    agents: localAgents.map((a) => ({
      id: a.id,
      available: a.available,
      isDefault: a.default,
    })),
  };
  const elsewhere = devices
    .filter((d) => d.id !== here.id && !d.revoked_at)
    .map<Machine>((d) => ({
      id: d.id,
      label: (d.label || "").trim() || d.id,
      isSelf: false,
      online: d.reachability === "online",
      roots: d.workspace_roots ?? [],
      agents: (d.agents ?? []).map((a) => ({
        id: a.id,
        available: a.available,
        reason: a.reason,
        isDefault: a.is_default,
      })),
    }))
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  return [here, ...elsewhere];
}

export function findMachine(machines: Machine[], id: string | undefined): Machine | undefined {
  if (!id) return undefined;
  return machines.find((m) => m.id === id);
}

/**
 * What to call the machine a task runs on. An empty id means the daemon that
 * serves this console; an id nobody recognises is still shown as-is rather than
 * dressed up as "this machine" — a task whose machine was revoked or belongs to
 * another Hub must not read as local.
 */
export function machineLabelFor(
  machines: Machine[],
  deviceId: string | undefined,
): { text: string; isSelf: boolean; known: boolean } {
  const id = (deviceId ?? "").trim();
  if (!id) return { text: "", isSelf: true, known: true };
  const machine = machines.find((m) => m.id === id);
  if (!machine) return { text: id, isSelf: false, known: false };
  return { text: machine.label, isSelf: machine.isSelf, known: true };
}

/** Directories to suggest for a machine: its own, never another machine's. */
export function cwdSuggestions(machine: Machine | undefined, localDirs: string[]): string[] {
  if (!machine || machine.isSelf) return localDirs;
  return machine.roots;
}

/**
 * Switching machines keeps whatever the user typed, and replaces a directory
 * that was only ever a suggestion from the previous machine — a path suggestion
 * carried across machines is exactly the quiet mistake this feature exists to
 * prevent.
 */
export function cwdAfterMachineChange(current: string, before: string[], after: string[]): string {
  const trimmed = current.trim();
  if (trimmed && !before.includes(trimmed)) return current;
  return after[0] ?? "";
}

/** The agent a fresh task on this machine would use when none is chosen. */
export function defaultAgentOn(machine: Machine | undefined): MachineAgent | undefined {
  if (!machine) return undefined;
  const usable = machine.agents.filter((a) => a.available);
  return usable.find((a) => a.isDefault) ?? usable[0];
}

/** Whether this machine can start a turn right now. */
export function canRunTasks(machine: Machine | undefined): boolean {
  return Boolean(machine && machine.online);
}
