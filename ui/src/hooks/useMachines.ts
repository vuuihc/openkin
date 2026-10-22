import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  listAgents,
  listDevices,
  serverVersion,
  type AgentInfo,
  type DeviceInfo,
} from "../api/client";
import { machineList, type Machine, type SelfIdentity } from "../lib/devices";

type Snapshot = {
  machines: Machine[];
  /** The local registry, as read for the machine list. Shared so a page does not
   *  ask for the same list twice and then disagree with itself. */
  agents: AgentInfo[];
  failed: boolean;
  loaded: boolean;
  at: number;
};

const EMPTY: Snapshot = {
  machines: [],
  agents: [],
  failed: false,
  loaded: false,
  at: 0,
};

/** How long a machine list stays fresh. Long enough that opening a page is not
 *  a request storm, short enough that a machine paired a moment ago shows up. */
const STALE_MS = 30_000;

/** A read that failed is usually a daemon still coming up. Retry on this beat
 *  instead of holding the failure for the life of the page. */
const RETRY_MS = 5_000;

let snapshot: Snapshot = EMPTY;
let inflight: Promise<void> | null = null;
/** A load that started before the cache was cleared must not publish into it. */
let generation = 0;
const listeners = new Set<() => void>();

function emit(next: Snapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Snapshot {
  return snapshot;
}

async function load(mine: number): Promise<void> {
  const [version, devices] = await Promise.all([
    serverVersion().catch(() => null),
    listDevices().catch(() => null),
  ]);
  if (mine !== generation) return;

  const self: SelfIdentity = {
    id: version?.desktop_id ?? "",
    name: version?.desktop_name ?? "",
  };
  const list: DeviceInfo[] = devices ?? [];
  // Which machine this is, and which machines exist, are the whole answer for
  // naming one. Publish that now: the agent inventory can wait on a CLI probe
  // or a provider, and until it lands a task that names this very machine would
  // read as one that has gone away.
  emit({
    // A console that cannot read the device list still knows which machine it is
    // talking to, so it degrades to one machine instead of to none.
    machines: machineList(list, self, snapshot.agents),
    agents: snapshot.agents,
    failed: devices === null || version === null,
    loaded: true,
    at: Date.now(),
  });

  const agents = await listAgents().catch(() => null);
  if (agents === null || mine !== generation) return;
  emit({ ...snapshot, machines: machineList(list, self, agents), agents });
}

function refresh(): void {
  if (inflight) return;
  const run = load(generation).finally(() => {
    if (inflight === run) inflight = null;
  });
  inflight = run;
}

/** Forget the cached machine list. Tests only; the page keeps it warm. */
export function resetMachinesCache(): void {
  generation += 1;
  snapshot = EMPTY;
  inflight = null;
}

export type MachinesState = {
  machines: Machine[];
  /** The local agent registry, from the same read as the machine list. */
  agents: AgentInfo[];
  loading: boolean;
  /** The device list could not be read; only this machine is known. */
  failed: boolean;
  refresh: () => void;
};

/**
 * The machines this console can send work to, this one first.
 *
 * One read is shared by every caller: a device list changes when someone pairs
 * a laptop, not while a page is open. The shared snapshot is what keeps two
 * places that both name a machine — the composer and the task header, say —
 * from disagreeing about it.
 */
export function useMachines(): MachinesState {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!current.loaded || Date.now() - current.at > STALE_MS) {
      refresh();
      return;
    }
    if (!current.failed) return;
    // Nothing else would ever retry: this hook is mounted for the life of the
    // page, and its dependencies do not change on their own.
    const timer = setTimeout(refresh, RETRY_MS);
    return () => clearTimeout(timer);
  }, [current.loaded, current.at, current.failed]);

  return {
    machines: current.loaded ? current.machines : [],
    agents: current.agents,
    loading: !current.loaded,
    failed: current.failed,
    refresh: useCallback(() => {
      refresh();
    }, []),
  };
}
