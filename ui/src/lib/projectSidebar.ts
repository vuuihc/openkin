/** Sidebar project grouping: sort modes + pin / archive state (localStorage). */

import { projectLabel } from "./paths";
import type { Task } from "../api/client";

export type ProjectSortMode = "recent" | "created";

export type ProjectGroup = {
  label: string;
  cwd: string;
  items: Task[];
  pinned: boolean;
  archived: boolean;
  /** ms — max task activity (+ local last interact) for recent sort */
  lastInteractedAt: number;
  /** ms — earliest task created_at for created sort */
  createdAt: number;
};

const SORT_KEY = "kin_project_sort_mode";
const PINNED_KEY = "kin_pinned_projects";
const ARCHIVED_KEY = "kin_archived_projects";
const INTERACT_KEY = "kin_project_last_interacted";

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
    if (v === "recent" || v === "created") return v;
  } catch {
    // ignore
  }
  return "recent";
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
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
  } catch {
    return [];
  }
}

function writeStringList(key: string, list: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // ignore
  }
  emit();
}

/** Pinned project cwds in pin order (original path casing preserved). */
export function getPinnedProjects(): string[] {
  return readStringList(PINNED_KEY);
}

export function isProjectPinned(cwd: string): boolean {
  const key = normCwd(cwd);
  return getPinnedProjects().some((p) => normCwd(p) === key);
}

export function toggleProjectPinned(cwd: string): boolean {
  const key = normCwd(cwd);
  const list = getPinnedProjects();
  const idx = list.findIndex((p) => normCwd(p) === key);
  if (idx >= 0) {
    list.splice(idx, 1);
    writeStringList(PINNED_KEY, list);
    return false;
  }
  // Pinning an archived project also restores it to the main list.
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
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function getProjectLastInteracted(cwd: string): number {
  const map = readLastInteractedMap();
  return map[normCwd(cwd)] ?? 0;
}

/** Bump local last-interact time (e.g. open a chat under this project). */
export function touchProject(cwd: string, at = Date.now()): void {
  if (!cwd) return;
  const map = readLastInteractedMap();
  const key = normCwd(cwd);
  // Skip no-op writes (same second) to avoid extra sidebar re-renders.
  if ((map[key] ?? 0) >= at) {
    // Still restore if user opened an archived project via deep link / tasks page.
    if (isProjectArchived(cwd)) unarchiveProject(cwd);
    return;
  }
  map[key] = at;
  try {
    localStorage.setItem(INTERACT_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
  if (isProjectArchived(cwd)) {
    // Opening a project restores it to the main list.
    const list = getArchivedProjects().filter((p) => normCwd(p) !== key);
    try {
      localStorage.setItem(ARCHIVED_KEY, JSON.stringify(list));
    } catch {
      // ignore
    }
  }
  emit();
}

/** Max activity timestamp for a single task (ms). */
export function taskActivityAt(task: Task): number {
  let t = task.created_at || 0;
  if (task.started_at != null && task.started_at > t) t = task.started_at;
  if (task.finished_at != null && task.finished_at > t) t = task.finished_at;
  return t;
}

export type GroupByProjectPrefs = {
  sortMode?: ProjectSortMode;
  pinned?: string[];
  archived?: string[];
  lastInteracted?: Record<string, number>;
  /**
   * When true (default), archived projects are omitted from the result.
   * Pass false to build the archived section.
   */
  includeArchived?: boolean;
  /** Only archived projects (for the archived section). */
  onlyArchived?: boolean;
};

/**
 * Group tasks by project cwd, apply sort mode + pins (+ optional archive filter).
 * Pure when prefs are passed in (tests); otherwise reads localStorage.
 */
export function groupByProject(
  tasks: Task[],
  prefs?: GroupByProjectPrefs,
): ProjectGroup[] {
  const sortMode = prefs?.sortMode ?? getProjectSortMode();
  const pinnedList = prefs?.pinned ?? getPinnedProjects();
  const archivedList = prefs?.archived ?? getArchivedProjects();
  const lastMap = prefs?.lastInteracted ?? readLastInteractedMap();
  const includeArchived = prefs?.includeArchived ?? false;
  const onlyArchived = prefs?.onlyArchived ?? false;

  const pinRank = new Map<string, number>();
  pinnedList.forEach((p, i) => {
    pinRank.set(normCwd(p), i);
  });
  const archivedSet = new Set(archivedList.map(normCwd));

  const map = new Map<string, Task[]>();
  for (const t of tasks) {
    const key = t.cwd || "unknown";
    const list = map.get(key) ?? [];
    list.push(t);
    map.set(key, list);
  }

  const groups: ProjectGroup[] = [];
  for (const [cwd, items] of map.entries()) {
    const archived = archivedSet.has(normCwd(cwd));
    if (onlyArchived && !archived) continue;
    if (!onlyArchived && !includeArchived && archived) continue;

    // Keep full sorted list; Sidebar ProjectBlock collapses to a preview + scroll.
    const sortedItems = items
      .slice()
      .sort((a, b) => taskActivityAt(b) - taskActivityAt(a) || b.created_at - a.created_at);
    let lastTask = 0;
    let created = Number.POSITIVE_INFINITY;
    for (const t of items) {
      const act = taskActivityAt(t);
      if (act > lastTask) lastTask = act;
      if (t.created_at > 0 && t.created_at < created) created = t.created_at;
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
    if (sortMode === "created") {
      const d = b.createdAt - a.createdAt;
      if (d !== 0) return d;
    } else {
      const d = b.lastInteractedAt - a.lastInteractedAt;
      if (d !== 0) return d;
    }
    return a.label.localeCompare(b.label);
  });

  return groups;
}
