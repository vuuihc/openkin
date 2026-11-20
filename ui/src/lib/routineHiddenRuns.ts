/**
 * The routine inbox's hidden runs, one id list per machine.
 *
 * Hiding is a local preference, exactly like `taskOrder.ts`: it lives in
 * localStorage, never syncs, and no other device or surface hears about it.
 * It removes rows from the inbox feed only — the run, its conversation, the
 * workspace and the routine's own history are untouched, and that history is
 * where a hidden run stays findable.
 *
 * Bad storage reads as "nothing hidden": a broken preference must not break
 * the feed.
 */

const STORAGE_KEY = "kin_routine_hidden_runs";

/** One machine's list cannot grow without bound; the oldest hides fall off. */
export const HIDDEN_RUNS_MAX = 500;

type HiddenRuns = Record<string, string[]>;

/** Read every machine's list; anything malformed is treated as absent. */
function read(): HiddenRuns {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: HiddenRuns = {};
    for (const [scope, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(ids)) continue;
      const clean = ids.filter((id): id is string => typeof id === "string");
      if (clean.length > 0) out[scope] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

function write(all: HiddenRuns): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // The write is best effort: if storage is full or blocked the hides are
    // simply not remembered across reloads, and the caller's in-memory set
    // still answers for this visit.
  }
}

/** The ids hidden on one machine. */
export function getHiddenRunIds(scope: string): Set<string> {
  return new Set(read()[scope] ?? []);
}

/**
 * Hide `ids` on one machine, returning the resulting set. An id already hidden
 * stays where it was, so hiding again cannot reorder the cap's oldest ids.
 */
export function hideRunIds(scope: string, ids: readonly string[]): Set<string> {
  const all = read();
  const existing = all[scope] ?? [];
  const known = new Set(existing);
  const added = ids.filter((id) => !known.has(id));
  const next = [...existing, ...added].slice(-HIDDEN_RUNS_MAX);
  write({ ...all, [scope]: next });
  return new Set(next);
}

/** Forget every hide on one machine, leaving other machines' lists alone. */
export function unhideAll(scope: string): void {
  const all = read();
  if (!(scope in all)) return;
  delete all[scope];
  write(all);
}
