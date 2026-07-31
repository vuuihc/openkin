/** Sidebar project grouping: sort modes + pin / archive state (localStorage). */

import { projectLabel } from "./paths";
import type { Task } from "../api/client";

export type ProjectSortMode = "active" | "created";

export type ProjectGroup = {
  label: string;
  cwd: string;
  items: Task[];
  pinned: boolean;
  archived: boolean;
  /** ms — max task activity (+ local last interact); used as secondary sort in active mode */
  lastInteractedAt: number;
  /** ms — earliest task created_at for created sort */
  createdAt: number;
  /** Whether this project has any non-terminal task (running / pending). */
  hasActiveTask: boolean;
};

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

export function isProjectPinned(cwd: string): boolean {
  const key = normCwd(cwd);
  return getPinnedProjects().some((p) => normCwd(p) === key);
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

/** Max activity timestamp for a single task (ms). Includes local open/follow-up. */
export function taskActivityAt(
  t: Task,
  sessionMap: Record<string, number>,
): number {
  const localTouch = sessionMap[t.id] ?? 0;
  return Math.max(localTouch, t.finished_at ?? 0, t.started_at ?? 0, t.created_at ?? 0);
}

function isActiveTask(t: Task): boolean {
  return t.status !== "succeeded" && t.status !== "failed" && t.status !== "canceled";
}

export type ProjectSidebarPrefs = {
  sortMode?: ProjectSortMode;
  pinned: string[];
  archived: string[];
  lastInteracted: Record<string, number>;
  /** Override session last-interact map (for tests). */
  sessionLastInteracted?: Record<string, number>;
};

/**
 * Group tasks by project cwd, apply sort mode + pins (+ optional archive filter).
 *
 * @param includeArchived When true, archived projects are kept in the result.
 *                        Default false so the main sidebar list omits them
 *                        (archived section calls with onlyArchived=true instead).
 * @param onlyArchived    When true, return only archived projects.
 * Pure when prefs are passed in (tests); otherwise reads localStorage.
 */
export function groupByProject(
  tasks: Task[],
  prefs?: ProjectSidebarPrefs | null,
  includeArchived = false,
  onlyArchived = false,
): ProjectGroup[] {
  const sortMode = prefs?.sortMode ?? getProjectSortMode();
  const pinnedCwds = prefs?.pinned ?? getPinnedProjects();
  const archivedCwds = prefs?.archived ?? getArchivedProjects();
  const lastMap = prefs?.lastInteracted ?? readLastInteractedMap();
  const sessionMap = prefs?.sessionLastInteracted ?? readSessionLastInteractedMap();

  const archivedSet = new Set(archivedCwds.map(normCwd));
  const pinRank = new Map<string, number>();
  pinnedCwds.forEach((c, i) => pinRank.set(normCwd(c), i));

  // Group tasks by project (cwd).
  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = t.cwd || "__root__";
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    list.push(t);
  }

  const groups: ProjectGroup[] = [];
  for (const [cwd, items] of map.entries()) {
    const archived = archivedSet.has(normCwd(cwd));
    if (onlyArchived && !archived) continue;
    if (!onlyArchived && !includeArchived && archived) continue;

    // Keep full sorted list; Sidebar ProjectBlock collapses to a preview + scroll.
    // Sessions sorted by agent last-response time (finished_at), not user click time.
    const sortedItems = items
      .slice()
      .sort(
        (a, b) =>
          // Active tasks first
          (isActiveTask(b) ? 1 : 0) - (isActiveTask(a) ? 1 : 0) ||
          (b.finished_at ?? 0) - (a.finished_at ?? 0) ||
          (b.started_at ?? 0) - (a.started_at ?? 0) ||
          b.created_at - a.created_at,
      );
    let lastTask = 0;
    let created = Number.POSITIVE_INFINITY;
    let hasActive = false;
    for (const t of items) {
      const act = taskActivityAt(t, sessionMap);
      if (act > lastTask) lastTask = act;
      if (t.created_at > 0 && t.created_at < created) created = t.created_at;
      if (isActiveTask(t)) hasActive = true;
    }
    if (!Number.isFinite(created)) created = 0;
    const local = lastMap[normCwd(cwd)] ?? 0;
    groups.push({
      cwd,
      label: projectLabel(cwd),
      items: sortedItems,
      pinned: pinRank.has(normCwd(cwd)),
      archived,
      lastInteractedAt: Math.max(lastTask, local),
      createdAt: created,
      hasActiveTask: hasActive,
    });
  }

  groups.sort((a, b) => {
    if (!onlyArchived) {
      const aPin = pinRank.has(normCwd(a.cwd));
      const bPin = pinRank.has(normCwd(b.cwd));
      if (aPin !== bPin) return aPin ? -1 : 1;
      if (aPin && bPin) {
        return (pinRank.get(normCwd(a.cwd)) ?? 0) - (pinRank.get(normCwd(b.cwd)) ?? 0);
      }
    }
    // "active" mode: projects with active (running/pending) tasks first
    if (sortMode === "active") {
      if (a.hasActiveTask !== b.hasActiveTask) {
        return a.hasActiveTask ? -1 : 1;
      }
      // Within the same tier, sort by recency
      const d = b.lastInteractedAt - a.lastInteractedAt;
      if (d !== 0) return d;
    } else {
      const d = b.createdAt - a.createdAt;
      if (d !== 0) return d;
    }
    return a.label.localeCompare(b.label);
  });

  return groups;
}
