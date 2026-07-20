/** Client-only: which terminal sessions the user has already opened. */

const STORAGE_KEY = "kin_session_viewed";
const EVENT = "kin:session-viewed";

type ViewedMap = Record<string, number>;

const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // ignore listener errors
    }
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(EVENT));
  }
}

function readMap(): ViewedMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: ViewedMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && k) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(map: ViewedMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota / private mode
  }
  emit();
}

/** Subscribe to viewed-state changes (same-tab + storage). */
export function subscribeSessionViewed(listener: () => void): () => void {
  listeners.add(listener);
  if (typeof window === "undefined") {
    return () => {
      listeners.delete(listener);
    };
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) listener();
  };
  const onCustom = () => listener();
  window.addEventListener("storage", onStorage);
  window.addEventListener(EVENT, onCustom);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(EVENT, onCustom);
  };
}

/** True when the user has opened this session after it finished. */
export function isSessionViewed(taskId: string): boolean {
  if (!taskId) return false;
  return readMap()[taskId] != null;
}

/**
 * Mark a session as viewed (clears the green completion dot).
 * No-op if already viewed.
 */
export function markSessionViewed(taskId: string, at = Date.now()): void {
  if (!taskId) return;
  const map = readMap();
  if (map[taskId] != null) return;
  map[taskId] = at;
  writeMap(map);
}

/** Snapshot for pure helpers / tests. */
export function getViewedSessionIds(): string[] {
  return Object.keys(readMap());
}

/**
 * Status-dot class for a sidebar session row.
 * - running / queued / waiting: blue pulse
 * - failed: red
 * - succeeded (unviewed): green
 * - succeeded (viewed) / canceled: none
 */
export function sessionStatusDotClass(
  status: string,
  viewed: boolean,
): string | null {
  if (status === "failed") return "bg-kin-red";
  if (status === "canceled") return null;
  if (status === "succeeded") {
    return viewed ? null : "bg-kin-green";
  }
  // running | queued | waiting_approval | …
  return "bg-kin-blue animate-pulse";
}
