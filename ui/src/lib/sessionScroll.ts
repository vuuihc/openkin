/** Client-only: remember chat scroll position per task session. */

const STORAGE_KEY = "kin_session_scroll";
const MAX_ENTRIES = 80;

type ScrollMap = Record<string, number>;

function readMap(): ScrollMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ScrollMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0 && k) {
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

/** Last known scrollTop for a task, or null if never saved. */
export function getSessionScroll(taskId: string): number | null {
  if (!taskId) return null;
  const v = readMap()[taskId];
  return typeof v === "number" ? v : null;
}

/** Persist scrollTop for a task (LRU-ish: drop oldest keys when oversized). */
export function setSessionScroll(taskId: string, scrollTop: number): void {
  if (!taskId || !Number.isFinite(scrollTop) || scrollTop < 0) return;
  const map = readMap();
  // Re-insert so this key is treated as most recent when pruning.
  if (taskId in map) delete map[taskId];
  map[taskId] = Math.round(scrollTop);
  const keys = Object.keys(map);
  if (keys.length > MAX_ENTRIES) {
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) {
      delete map[k];
    }
  }
  writeMap(map);
}

export function clearSessionScroll(taskId: string): void {
  if (!taskId) return;
  const map = readMap();
  if (!(taskId in map)) return;
  delete map[taskId];
  writeMap(map);
}
