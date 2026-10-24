import type { AgentInfo, DeviceInfo } from "../api/client";
import { agentDisplayName } from "./agentMention";

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
  installed: boolean;
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
      installed: a.installed,
      available: a.available,
      reason: a.reason,
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
        installed: a.installed,
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

/**
 * The machine a task runs on, when that is *not* the machine showing the page.
 *
 * Null covers both "runs here" and "no machine recorded", which read the same
 * to a reader: nothing to explain. A machine this console cannot see any more
 * still comes back (known: false), so a revoked device is named rather than
 * silently presented as local.
 */
export function remoteMachine(
  machines: Machine[],
  deviceId: string | undefined,
): { text: string; known: boolean } | null {
  if (!deviceId) return null;
  const label = machineLabelFor(machines, deviceId);
  if (label.isSelf) return null;
  return { text: label.text, known: label.known };
}

/** Directories to suggest for a machine: its own, never another machine's. */
export function cwdSuggestions(machine: Machine | undefined, localDirs: string[]): string[] {
  if (!machine || machine.isSelf) return localDirs;
  return machine.roots;
}

/**
 * Whether a device id names a machine other than the one serving this console.
 *
 * An empty id and the literal "self" both mean here — the API accepts either for
 * the same thing, and a form that only knows "some machine" should not have to
 * know which kind it has.
 */
export function isRemoteDevice(device: string | undefined): boolean {
  const id = (device ?? "").trim();
  return id !== "" && id !== "self";
}

/**
 * How a person chooses a working directory on one machine.
 *
 * The native folder dialog reads the filesystem this console is running on, so
 * it can only answer about this machine — and only when the console is the
 * desktop app. Everything else browses: a browser, a phone, and any form aimed
 * at another machine, where the directories are on that machine and the only
 * party that can answer is that machine.
 */
export function cwdPickerMode(desktop: boolean, device: string | undefined): "native" | "browse" {
  return desktop && !isRemoteDevice(device) ? "native" : "browse";
}

/**
 * A device id as the machine endpoints name it.
 *
 * The server reads an empty id and "self" as the same machine, so this only has
 * to pick one of them; it picks the literal, because it survives being put in a
 * path without becoming a double slash.
 */
export function machineRef(device: string | undefined): string {
  return isRemoteDevice(device) ? encodeURIComponent(device!.trim()) : "self";
}

/**
 * Whether a directory the browser walked to can be handed back as a working
 * directory.
 *
 * Where the person walked to is not the same as what the machine has confirmed:
 * `path` is only known to be a directory there because that machine listed it,
 * and a listing that failed is exactly the case where it is not. Picking it
 * anyway would pin a session to a directory that may not exist — and the console
 * cannot tell, because that filesystem is not this one.
 */
export function folderPickable(state: {
  path: string;
  loading: boolean;
  failed: boolean;
}): boolean {
  return state.path.trim() !== "" && !state.loading && !state.failed;
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

/**
 * The agents to offer for a machine.
 *
 * For this machine that is the local registry. For another machine it is what
 * that machine reported — and nothing else, because that list is what the Hub
 * validates a dispatched agent against: offering an agent the target does not
 * have would turn a click into a rejected request.
 */
export function catalogFor(
  machine: Machine | undefined,
  localAgents: AgentInfo[],
): AgentInfo[] {
  if (!machine || machine.isSelf) return localAgents;
  return machine.agents.map((a) => ({
    id: a.id,
    name: agentDisplayName(a.id),
    kind: "cli",
    capabilities: [],
    installed: a.installed,
    available: a.available,
    default: Boolean(a.isDefault),
    reason: a.reason,
    model_list_source: "none",
    model_list_status: "unavailable",
  }));
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
