/**
 * Persisted scroll positions (localStorage).
 * Chat: keep-alive hides inactive sessions with display:none, which resets
 * scrollTop — so we persist and restore explicitly. The same map also holds a
 * page's list offset under its own key (see getKeyedScroll).
 */

const STORAGE_KEY = "kin.sessionScroll.v1";
const MAX_ENTRIES = 40;

type ScrollMap = Record<string, number>;

function readMap(): ScrollMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: ScrollMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(map: ScrollMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota / private mode
  }
}

/** Last known scrollTop for a key, or null if never saved. */
export function getKeyedScroll(key: string): number | null {
  if (!key) return null;
  const v = readMap()[key];
  return typeof v === "number" ? v : null;
}

/** Persist scrollTop for a key (LRU-ish: drop oldest keys when oversized). */
export function setKeyedScroll(key: string, scrollTop: number): void {
  if (!key || !Number.isFinite(scrollTop) || scrollTop < 0) return;
  const map = readMap();
  // Re-insert so this key is treated as most recent when pruning.
  if (key in map) delete map[key];
  map[key] = Math.round(scrollTop);
  const keys = Object.keys(map);
  if (keys.length > MAX_ENTRIES) {
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) {
      delete map[k];
    }
  }
  writeMap(map);
}

/** Last known scrollTop for a task, or null if never saved. */
export function getSessionScroll(taskId: string): number | null {
  return getKeyedScroll(taskId);
}

/** Persist scrollTop for a task. */
export function setSessionScroll(taskId: string, scrollTop: number): void {
  setKeyedScroll(taskId, scrollTop);
}

export function clearSessionScroll(taskId: string): void {
  if (!taskId) return;
  const map = readMap();
  if (!(taskId in map)) return;
  delete map[taskId];
  writeMap(map);
}
