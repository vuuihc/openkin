import { useCallback, useEffect, useState } from "react";
import {
  listAgents,
  listDevices,
  serverVersion,
  type AgentInfo,
  type DeviceInfo,
  type ServerVersion,
} from "../api/client";
import { machineList, type Machine, type SelfIdentity } from "../lib/devices";

type Snapshot = { machines: Machine[]; failed: boolean };

let cache: Snapshot | null = null;
let inflight: Promise<Snapshot> | null = null;

/** Forget the cached machine list (tests, and an explicit refresh). */
export function resetMachinesCache(): void {
  cache = null;
  inflight = null;
}

async function load(): Promise<Snapshot> {
  const [version, devices, agents] = await Promise.all([
    serverVersion().catch(() => ({}) as ServerVersion),
    listDevices().catch(() => null),
    listAgents().catch(() => [] as AgentInfo[]),
  ]);
  const self: SelfIdentity = {
    id: version.desktop_id ?? "",
    name: version.desktop_name ?? "",
  };
  const list: DeviceInfo[] = devices ?? [];
  return {
    // A console that cannot read the device list still knows which machine it is
    // talking to, so it degrades to one machine instead of to none.
    machines: machineList(list, self, agents),
    failed: devices === null,
  };
}

export type MachinesState = {
  machines: Machine[];
  loading: boolean;
  /** The device list could not be read; only this machine is known. */
  failed: boolean;
  refresh: () => void;
};

/**
 * The machines this console can send work to, this one first. One fetch is
 * shared by every caller and kept for the life of the page: a device list
 * changes when someone pairs a laptop, not while a dialog is open.
 */
export function useMachines(): MachinesState {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(cache);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    if (nonce === 0 && cache) return;
    inflight ??= load().finally(() => {
      inflight = null;
    });
    void inflight.then((next) => {
      cache = next;
      if (alive) setSnapshot(next);
    });
    return () => {
      alive = false;
    };
  }, [nonce]);

  const refresh = useCallback(() => {
    resetMachinesCache();
    setNonce((n) => n + 1);
  }, []);

  return {
    machines: snapshot?.machines ?? [],
    loading: snapshot === null,
    failed: snapshot?.failed ?? false,
    refresh,
  };
}
