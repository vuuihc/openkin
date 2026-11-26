/**
 * Which project groups the conversation list opens with.
 *
 * `sessionFolds.ts` stores what the person folded; this module decides what a
 * group nobody has folded yet does on the first paint. The list is scanned,
 * not browsed: devices stay open, a project's conversations are only worth the
 * fold they spend when the project is the one the person was last in, so the
 * default is "the project holding the newest conversation, and nothing else".
 * Imported groups keep their old default — folded until someone opens them —
 * because an import is an index, not a place.
 *
 * A stored fold outranks the default. It is also an opinion about the whole
 * list rather than one key: someone who opened project B last time expects B,
 * not B plus the default-open latest, so once any project carries an explicit
 * fold every project without one starts closed.
 *
 * Pure: no storage, no clock, no DOM, so the defaults are testable without
 * rendering the list.
 */

export type SessionListFoldCandidate = {
  /** The key `sessionFolds.ts` stores this group's fold under. */
  stateKey: string;
  /** The synthetic imported group, which is folded by default. */
  imported: boolean;
  /** The synthetic pinned bucket. It is foldable and remembers a fold, but it
   *  is not a project: it never takes the one default-open fold. */
  pinned?: boolean;
  /** The newest row in the group; 0 for a heading with no conversations yet. */
  lastActivityAt: number;
};

export function resolveSessionListFolds(
  candidates: readonly SessionListFoldCandidate[],
  stored: Readonly<Record<string, boolean>>,
): Record<string, boolean> {
  // A heading with no rows is never "the latest": a seeded project record has
  // nothing to open, so it must not take the one open fold from a project that
  // does. The pinned bucket is not a place either. Ties break on the key so
  // two rows stamped the same millisecond do not move the open project between
  // renders.
  const newest = candidates
    .filter((candidate) => !candidate.imported && !candidate.pinned && candidate.lastActivityAt > 0)
    .sort(
      (a, b) =>
        b.lastActivityAt - a.lastActivityAt ||
        (a.stateKey < b.stateKey ? -1 : a.stateKey > b.stateKey ? 1 : 0),
    )[0];

  const remembersProjects = candidates.some(
    (candidate) =>
      !candidate.imported && Object.prototype.hasOwnProperty.call(stored, candidate.stateKey),
  );

  const resolved: Record<string, boolean> = {};
  for (const candidate of candidates) {
    if (Object.prototype.hasOwnProperty.call(stored, candidate.stateKey)) {
      resolved[candidate.stateKey] = stored[candidate.stateKey];
      continue;
    }
    resolved[candidate.stateKey] = candidate.imported
      ? false
      : !remembersProjects && candidate.stateKey === newest?.stateKey;
  }
  return resolved;
}
