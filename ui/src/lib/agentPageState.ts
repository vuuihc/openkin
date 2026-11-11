/**
 * What the agents console remembers between visits, and what it deliberately
 * does not.
 *
 * The catalog is curated by a person: a product enters only after the connect
 * confirmation, and leaving the page must not quietly re-add the products it
 * left out (KIN-AGENTS-001 steps 1, 4 and 7). The daemon has no setting for
 * this and the story forbids adding one, so the list lives in this browser.
 * That is a real limit — the same machine seen from another browser starts from
 * its own seed — and the seed is the products Kin can host, which is the set
 * the new-chat picker already offered.
 *
 * Precise empty states matter here: "never stored" (`null`) seeds the catalog,
 * while "stored empty" (`[]`) is a person who removed everything and must stay
 * removed. Collapsing the two would resurrect agents on every reload.
 *
 * Everything is convenience, never a source of truth: reads and writes are
 * guarded because private windows and blocked storage throw, and a miss costs
 * one seeded first paint.
 */

export type UsageDays = 7 | 30 | 90;

export type AgentSortKey =
  | "name"
  | "status"
  | "version"
  | "auth"
  | "cost"
  | "tokens"
  | "tasks";

export type AgentSortDir = "asc" | "desc";

export type AgentPagePrefs = {
  days: UsageDays;
  sortKey: AgentSortKey;
  sortDir: AgentSortDir;
};

type Store = Pick<Storage, "getItem" | "setItem">;

const CONNECTED_KEY = "kin_agents_connected:v1";
const PREFS_KEY = "kin_agents_prefs:v1";
const QUOTA_KEY = "kin_agents_quota_wait:v1";

function store(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // A blocked storage accessor throws rather than returning undefined.
    return null;
  }
}

function readRaw(key: string, storage: Store | null): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string, storage: Store | null): void {
  if (!storage) return;
  try {
    storage.setItem(key, value);
  } catch {
    // Full or blocked storage is not the page's problem.
  }
}

/**
 * The stored catalog, or null when this console has never stored one.
 *
 * An empty array is an answer ("every product was removed") and is returned as
 * such; only a missing or unreadable entry is null.
 */
export function readConnectedFamilies(storage: Store | null = store()): string[] | null {
  const raw = readRaw(CONNECTED_KEY, storage);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  } catch {
    return null;
  }
}

export function writeConnectedFamilies(
  families: readonly string[],
  storage: Store | null = store(),
): void {
  writeRaw(CONNECTED_KEY, JSON.stringify(families), storage);
}

const SORT_KEYS: readonly AgentSortKey[] = [
  "name",
  "status",
  "version",
  "auth",
  "cost",
  "tokens",
  "tasks",
];

/** The last interval and sort, ignoring anything a newer version changed. */
export function readAgentPagePrefs(storage: Store | null = store()): Partial<AgentPagePrefs> {
  const raw = readRaw(PREFS_KEY, storage);
  if (raw === null) return {};
  try {
    const parsed = JSON.parse(raw) as Partial<AgentPagePrefs> | null;
    if (!parsed || typeof parsed !== "object") return {};
    const prefs: Partial<AgentPagePrefs> = {};
    if (parsed.days === 7 || parsed.days === 30 || parsed.days === 90) prefs.days = parsed.days;
    if (parsed.sortKey && SORT_KEYS.includes(parsed.sortKey)) prefs.sortKey = parsed.sortKey;
    if (parsed.sortDir === "asc" || parsed.sortDir === "desc") prefs.sortDir = parsed.sortDir;
    return prefs;
  } catch {
    return {};
  }
}

export function writeAgentPagePrefs(
  prefs: AgentPagePrefs,
  storage: Store | null = store(),
): void {
  writeRaw(PREFS_KEY, JSON.stringify(prefs), storage);
}

/**
 * When this console first saw an agent waiting on its daily limit.
 *
 * The limits API reports today's usage and the start of the day, not the moment
 * the limit was crossed, so "waiting for 12 minutes" has no server timestamp to
 * stand on. What the console can honestly say is how long *it* has watched the
 * agent wait, keyed by the limit period so tomorrow starts over. A reload keeps
 * the observation; a different browser does not.
 */
function quotaKey(agent: string, periodStart: string): string {
  return `${agent}|${periodStart}`;
}

export function readQuotaWaitSince(
  agent: string,
  periodStart: string,
  storage: Store | null = store(),
): number | null {
  const raw = readRaw(QUOTA_KEY, storage);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed[quotaKey(agent, periodStart)];
    return typeof value === "number" && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeQuotaWaitSince(
  agent: string,
  periodStart: string,
  at: number,
  storage: Store | null = store(),
): void {
  const raw = readRaw(QUOTA_KEY, storage);
  let parsed: Record<string, number> = {};
  try {
    const candidate = raw ? (JSON.parse(raw) as unknown) : null;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      for (const [key, value] of Object.entries(candidate)) {
        if (typeof value === "number" && value > 0) parsed[key] = value;
      }
    }
  } catch {
    parsed = {};
  }
  parsed[quotaKey(agent, periodStart)] = at;
  // The map is one entry per agent per day; keeping a week of them is plenty
  // and stops a long-lived console from growing it forever. Evict the oldest
  // observation, not the oldest key: an agent that has waited for days holds
  // an early key and is exactly the entry still being read.
  const keys = Object.keys(parsed);
  if (keys.length > 40) {
    keys.sort((a, b) => parsed[a] - parsed[b]);
    for (const key of keys.slice(0, keys.length - 40)) delete parsed[key];
  }
  writeRaw(QUOTA_KEY, JSON.stringify(parsed), storage);
}
