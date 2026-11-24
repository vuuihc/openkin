/**
 * KIN-MOBILE-001 R3 — the conversation list's headless model.
 *
 * The grouping is not re-derived here: it is `ui/src/lib/phoneSessionBuckets.ts`
 * imported in place (ADR 0036 §2), so the phone and the web console answer
 * "which project does this row file under" with one function. What this module
 * adds is the phone's view state — loading/ready/empty/failed/offline, the
 * default folds, and the two rules every async answer owes its reader:
 * a late answer from an older generation is dropped (AGENTS.md rule 11), and a
 * wait is bounded (rule 13, via the transport's timeout).
 *
 * It is pure about storage: the screen injects a `FoldStore`, so this module
 * never reaches for `localStorage` and can be tested without a device.
 */

import type { Task } from "../../../ui/src/api/contract";
import type { Machine } from "../../../ui/src/lib/devices";
import {
  groupProjectBucketsByDevice,
  phoneProjectBuckets,
  type PhoneBucketCopy,
} from "../../../ui/src/lib/phoneSessionBuckets";
import {
  apiFetch,
  listTasksPath,
  type TransportReason,
} from "../api/transport";

export type ListStatus = "loading" | "ready" | "empty" | "failed" | "offline";

export type ListError = TransportReason;

/** One conversation row as the screen draws it: two lines, ≥44pt tall. */
export type ConversationRow = {
  id: string;
  title: string;
  agentId: string;
  /** The row's own clock, for ordering and for the relative-time label. */
  at: number;
  /** Supplied by the caller so the shared catalogue stays the only source. */
  timeLabel: string;
  /** A catalogue key, or null when the status has no signed word. */
  statusKey: string | null;
  /** Approvals plus questions waiting on this conversation. */
  pending: number;
  remote: boolean;
};

export type ProjectGroup = {
  key: string;
  label: string;
  open: boolean;
  lastActivityAt: number;
  rows: ConversationRow[];
};

export type DeviceGroup = {
  id: string;
  label: string;
  isSelf: boolean;
  online: boolean;
  count: number;
  projects: ProjectGroup[];
};

export type ListViewState = {
  status: ListStatus;
  groups: DeviceGroup[];
  error: ListError | null;
};

/** The signed status vocabulary, mapped to the catalogue keys the screen reads. */
const STATUS_KEYS: Record<string, string> = {
  running: "sessions.statusRunning",
  waiting_approval: "sessions.statusWaitingApproval",
  waiting_input: "sessions.statusWaitingInput",
  succeeded: "sessions.statusSucceeded",
  failed: "sessions.statusFailed",
  canceled: "sessions.statusCanceled",
};

/** Fold state persistence, injected by the screen (ADR 0036 §2 storage seam). */
export type FoldStore = {
  read(): Record<string, boolean>;
  write(stateKey: string, open: boolean): void;
};

/** An in-memory store for tests and for the first routed slice. */
export function createMemoryFoldStore(
  initial: Record<string, boolean> = {},
): FoldStore {
  let state: Record<string, boolean> = { ...initial };
  return {
    read: () => ({ ...state }),
    write: (stateKey, open) => {
      state = { ...state, [stateKey]: open };
    },
  };
}

/**
 * One project heading's fold key.
 *
 * The device is part of it because the same cwd can be a heading under two
 * machines, and folding one must not fold the other — the rule
 * `ui/src/lib/sessionFolds.ts` states for the web list.
 */
export function foldStateKey(deviceId: string, projectKey: string): string {
  return `${deviceId}\u0000${projectKey}`;
}

/**
 * The projects open when nothing is stored: only the one holding the newest
 * conversation, across the page (KIN-CONTINUE-007, step 2).
 */
export function defaultOpenKeys(
  groups: readonly DeviceGroup[],
): Set<string> {
  let newestKey = "";
  let newestAt = -Infinity;
  for (const device of groups) {
    for (const project of device.projects) {
      if (project.rows.length === 0) continue;
      if (project.lastActivityAt > newestAt) {
        newestAt = project.lastActivityAt;
        newestKey = foldStateKey(device.id, project.key);
      }
    }
  }
  return new Set(newestKey === "" ? [] : [newestKey]);
}

/** Apply stored folds, falling back to the newest-project default. */
export function applyFolds(
  groups: readonly DeviceGroup[],
  store: FoldStore,
): DeviceGroup[] {
  const stored = store.read();
  const defaults = defaultOpenKeys(groups);
  return groups.map((device) => ({
    ...device,
    projects: device.projects.map((project) => {
      const stateKey = foldStateKey(device.id, project.key);
      const persisted = stored[stateKey];
      return {
        ...project,
        open: persisted === undefined ? defaults.has(stateKey) : persisted,
      };
    }),
  }));
}

export type BuildGroupsOptions = {
  selfDeviceId: string;
  machines?: readonly Machine[];
  pendingByTask?: ReadonlyMap<string, number>;
  /** Catalogue lookups; the caller owns every user-visible word. */
  t: (key: string, params?: Record<string, string | number>) => string;
  /** The shared relative-time formatter, injected for the same reason. */
  formatTime?: (at: number) => string;
};

/** Group one page of tasks into device → project → conversation. */
export function buildListGroups(
  tasks: readonly Task[],
  options: BuildGroupsOptions,
): DeviceGroup[] {
  const copy: PhoneBucketCopy = {
    untitled: options.t("sessions.untitled"),
    noProject: options.t("sessions.noProject"),
    imported: options.t("sessions.importedLabel"),
  };
  const buckets = phoneProjectBuckets(
    tasks,
    [],
    options.selfDeviceId,
    copy,
  );
  const machines = options.machines ?? [];
  const devices = groupProjectBucketsByDevice(
    buckets,
    machines,
    options.selfDeviceId,
    { order: "activity", includeEmptyDevices: true },
  );
  const formatTime = options.formatTime ?? (() => "");

  return devices.map((device) => ({
    id: device.id,
    // A machine that has not named itself still needs a heading; the
    // catalogue says "this machine" rather than the screen inventing one.
    label: device.label || options.t("projects.thisMachine"),
    isSelf: device.isSelf,
    online: device.online,
    count: device.count,
    projects: device.buckets.map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      open: true,
      lastActivityAt: bucket.lastActivityAt,
      rows: bucket.rows.flatMap((row) => {
        // Imported agent sessions have no task id, so nothing can open them
        // yet; R3 draws the signed task rows only.
        if (!row.task) return [];
        return [
          {
            id: row.task.id,
            title: row.title,
            agentId: row.agentId,
            at: row.at,
            timeLabel: formatTime(row.at),
            statusKey: STATUS_KEYS[row.status ?? ""] ?? null,
            pending: options.pendingByTask?.get(row.task.id) ?? 0,
            remote: row.remote,
          },
        ];
      }),
    })),
  }));
}

/** Every wait is bounded; the transport applies this to the whole request. */
export const LIST_TIMEOUT_MS = 10_000;

export type ListControllerOptions = BuildGroupsOptions & {
  origin: string;
  token?: string | null;
  store?: FoldStore;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type ListController = {
  state(): ListViewState;
  /** Fetch the first page; a stale generation's answer never lands. */
  load(): Promise<ListViewState>;
  /** Flip one project's fold and remember it. */
  toggleProject(deviceId: string, projectKey: string): ListViewState;
};

/**
 * The list's request state machine.
 *
 * `load` is the only writer. Each call takes a generation; an answer whose
 * generation is no longer current is dropped whole, so a slow first read
 * cannot replace a newer one (rule 11). A failed refresh keeps the rows the
 * reader already has — losing them because the network blipped is the failure
 * the story's "已加载行不清空" row forbids.
 */
export function createListController(
  options: ListControllerOptions,
): ListController {
  const store = options.store ?? createMemoryFoldStore();
  let generation = 0;
  let state: ListViewState = { status: "loading", groups: [], error: null };

  const groupsOf = (tasks: readonly Task[]): DeviceGroup[] =>
    applyFolds(buildListGroups(tasks, options), store);

  return {
    state: () => state,

    async load(): Promise<ListViewState> {
      const mine = ++generation;
      if (state.groups.length === 0) {
        state = { status: "loading", groups: [], error: null };
      }
      const result = await apiFetch<Task[]>(options.origin, listTasksPath(), {
        token: options.token,
        fetchImpl: options.fetchImpl,
        timeoutMs: options.timeoutMs ?? LIST_TIMEOUT_MS,
      });
      if (mine !== generation) {
        // Another load started after this one; its answer is the one that
        // describes the screen the reader is looking at now.
        return state;
      }
      if (!result.ok) {
        const kept = state.groups;
        state = {
          status:
            kept.length > 0 && result.reason === "unreachable"
              ? "offline"
              : "failed",
          groups: kept,
          error: result.reason,
        };
        return state;
      }
      const groups = groupsOf(result.data);
      const empty = groups.every((device) =>
        device.projects.every((project) => project.rows.length === 0),
      );
      state = {
        status: empty ? "empty" : "ready",
        groups,
        error: null,
      };
      return state;
    },

    toggleProject(deviceId: string, projectKey: string): ListViewState {
      const device = state.groups.find((group) => group.id === deviceId);
      const project = device?.projects.find((item) => item.key === projectKey);
      if (!device || !project) return state;
      store.write(foldStateKey(deviceId, projectKey), !project.open);
      state = {
        ...state,
        groups: applyFolds(state.groups, store),
      };
      return state;
    },
  };
}
