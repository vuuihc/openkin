/** Project preferences shared by both list shells: sort mode, pins, archive, local recency. */

export type ProjectSortMode = "active" | "created";

const SORT_KEY = "kin_project_sort_mode";
const PINNED_KEY = "kin_pinned_projects";
const ARCHIVED_KEY = "kin_archived_projects";
const INTERACT_KEY = "kin_project_last_interacted";
const SESSION_INTERACT_KEY = "kin_session_last_interacted";
const SESSION_INTERACT_MAX = 500;

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) {
    try {
      l();
    } catch {
      // ignore listener errors
    }
  }
}

/** Subscribe to sort / pin / archive / last-interact changes. */
export function subscribeProjectSidebar(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function normCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function getProjectSortMode(): ProjectSortMode {
  try {
    const v = localStorage.getItem(SORT_KEY);
    if (v === "active" || v === "created") return v;
  } catch {
    // ignore
  }
  return "active";
}

export function setProjectSortMode(mode: ProjectSortMode): void {
  try {
    localStorage.setItem(SORT_KEY, mode);
  } catch {
    // ignore
  }
  emit();
}

function readStringList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === "string");
    return [];
  } catch {
    return [];
  }
}

function writeStringList(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // ignore quota / private mode
  }
  emit();
}

/** Pinned project cwds. Order = pin rank. */
export function getPinnedProjects(): string[] {
  return readStringList(PINNED_KEY);
}

/**
 * Toggle pinned state. Returns true if now pinned, false if unpinned.
 * Appending to the end of the pin list, so newest pin gets lowest rank.
 */
export function toggleProjectPinned(cwd: string): boolean {
  if (!cwd) return false;
  const key = normCwd(cwd);
  const list = getPinnedProjects();
  const idx = list.findIndex((p) => normCwd(p) === key);
  if (idx >= 0) {
    list.splice(idx, 1);
    writeStringList(PINNED_KEY, list);
    return false;
  }
  // Unarchive when pinning.
  if (isProjectArchived(cwd)) {
    setProjectArchived(cwd, false);
  }
  list.push(cwd);
  writeStringList(PINNED_KEY, list);
  return true;
}

/** Archived (hidden from main sidebar) project cwds. */
export function getArchivedProjects(): string[] {
  return readStringList(ARCHIVED_KEY);
}

/** Last local open/touch time per normalized cwd. The conversation list reads
 *  it so opening an old project brings its heading forward without changing
 *  the task's own timestamps. */
export function getProjectLastInteracted(): Record<string, number> {
  return readLastInteractedMap();
}

export function isProjectArchived(cwd: string): boolean {
  const key = normCwd(cwd);
  return getArchivedProjects().some((p) => normCwd(p) === key);
}

export function setProjectArchived(cwd: string, archived: boolean): void {
  if (!cwd) return;
  const key = normCwd(cwd);
  const list = getArchivedProjects();
  const idx = list.findIndex((p) => normCwd(p) === key);
  if (archived) {
    if (idx < 0) list.push(cwd);
    // Archiving clears pin so it does not reappear at top after restore surprises.
    const pins = getPinnedProjects().filter((p) => normCwd(p) !== key);
    if (pins.length !== getPinnedProjects().length) {
      try {
        localStorage.setItem(PINNED_KEY, JSON.stringify(pins));
      } catch {
        // ignore
      }
    }
  } else if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    return;
  }
  writeStringList(ARCHIVED_KEY, list);
}

export function archiveProject(cwd: string): void {
  setProjectArchived(cwd, true);
}

export function unarchiveProject(cwd: string): void {
  setProjectArchived(cwd, false);
}

function readLastInteractedMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(INTERACT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && k) out[normCwd(k)] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeLastInteractedMap(map: Record<string, number>): void {
  try {
    localStorage.setItem(INTERACT_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
  emit();
}

/**
 * Bump the top-level project lastInteractedAt timestamp for the given cwd.
 * Used when the user navigates to a project via cover page or opens a session
 * outside the sidebar (so the sidebar re-orders on next render).
 */
export function touchProject(cwd: string, at = Date.now()): void {
  if (!cwd) return;
  const key = normCwd(cwd);
  const map = readLastInteractedMap();
  if ((map[key] ?? 0) >= at) return;
  map[key] = at;
  writeLastInteractedMap(map);
}

function readSessionLastInteractedMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SESSION_INTERACT_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v) && k) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function writeSessionLastInteractedMap(map: Record<string, number>): void {
  // Cap growth: keep the most recent SESSION_INTERACT_MAX entries.
  let entries = Object.entries(map);
  if (entries.length > SESSION_INTERACT_MAX) {
    entries.sort((a, b) => b[1] - a[1]);
    entries = entries.slice(0, SESSION_INTERACT_MAX);
    map = Object.fromEntries(entries);
  }
  try {
    localStorage.setItem(SESSION_INTERACT_KEY, JSON.stringify(map));
  } catch {
    // ignore quota / private mode
  }
  emit();
}

/**
 * Bump a session's last-interact time so same-project sessions reorder by recency.
 * Used when the user opens a session or a follow-up/run updates it.
 */
export function touchSession(taskId: string, at = Date.now()): void {
  if (!taskId) return;
  const map = readSessionLastInteractedMap();
  if ((map[taskId] ?? 0) >= at) return;
  map[taskId] = at;
  writeSessionLastInteractedMap(map);
}
