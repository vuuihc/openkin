/**
 * The project order inside one machine.
 *
 * Both shells now draw the same list, so the order has to be one answer too.
 * It is the sidebar's old order — pinned projects first by pin rank, active
 * projects above idle ones, then recency (or creation) — applied to the buckets
 * the shared list builds. Imports and the no-project catch-all keep their tail
 * positions: they are shelves, not projects.
 */
import {
  getPinnedProjects,
  getProjectLastInteracted,
  getProjectSortMode,
  type ProjectSortMode,
} from "./projectSidebar";
import {
  isImportedBucket,
  UNASSIGNED_PROJECT,
  type PhoneProjectBucket,
} from "./phoneSessionBuckets";

function normCwd(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function sortSessionBuckets(
  buckets: readonly PhoneProjectBucket[],
  options?: {
    sortMode?: ProjectSortMode;
    pinned?: readonly string[];
    lastInteracted?: Record<string, number>;
    /** The archived view has no pin or active tier: it shows projects as filed. */
    archived?: boolean;
  },
): PhoneProjectBucket[] {
  const sortMode = options?.sortMode ?? getProjectSortMode();
  const pinnedCwds = options?.pinned ?? getPinnedProjects();
  const touched = options?.lastInteracted ?? getProjectLastInteracted();
  const pinRank = new Map<string, number>();
  if (!options?.archived) {
    pinnedCwds.forEach((cwd, index) => pinRank.set(normCwd(cwd), index));
  }

  const activity = (bucket: PhoneProjectBucket): number => {
    const key = normCwd(bucket.cwd);
    return Math.max(bucket.lastActivityAt, key ? (touched[key] ?? 0) : 0);
  };

  return [...buckets].sort((a, b) => {
    const aImported = isImportedBucket(a.key);
    const bImported = isImportedBucket(b.key);
    if (aImported !== bImported) return aImported ? 1 : -1;

    const aUnassigned = a.key === UNASSIGNED_PROJECT;
    const bUnassigned = b.key === UNASSIGNED_PROJECT;
    if (aUnassigned !== bUnassigned) return aUnassigned ? 1 : -1;

    if (!options?.archived) {
      const aPin = pinRank.has(normCwd(a.cwd));
      const bPin = pinRank.has(normCwd(b.cwd));
      if (aPin !== bPin) return aPin ? -1 : 1;
      if (aPin && bPin) {
        return (pinRank.get(normCwd(a.cwd)) ?? 0) - (pinRank.get(normCwd(b.cwd)) ?? 0);
      }
      if (sortMode === "active" && a.hasActiveTask !== b.hasActiveTask) {
        return a.hasActiveTask ? -1 : 1;
      }
    }

    if (sortMode === "active") {
      const recent = activity(b) - activity(a);
      if (recent !== 0) return recent;
    } else {
      const created = b.createdAt - a.createdAt;
      if (created !== 0) return created;
    }
    return a.label.localeCompare(b.label);
  });
}
