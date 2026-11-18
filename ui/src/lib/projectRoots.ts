/**
 * The rules a project's folder list obeys before it is edited or saved.
 *
 * `PATCH /api/projects/:id` replaces `roots` as a whole, so the editor works on
 * a draft list and hands the complete ordered list back. That makes the list
 * itself the unit of change: a blank, a duplicate or a stale position in the
 * draft would be written to the project, not merged away by the server. These
 * helpers are pure so the same rules hold for the editor, its tests, and any
 * future reader of a saved list.
 */

/** Trim, drop blanks, and keep the first occurrence's position. */
export function normalizeProjectRoots(roots: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of roots ?? []) {
    const root = raw.trim();
    if (!root || seen.has(root)) continue;
    seen.add(root);
    next.push(root);
  }
  return next;
}

/**
 * "Set as default" means "move to the front": the first folder is the default
 * everywhere the cover, the new-chat target and the daemon agree on it.
 */
export function makeProjectRootDefault(roots: readonly string[], root: string): string[] {
  const wanted = root.trim();
  const rest = roots.filter((candidate) => candidate !== wanted);
  if (rest.length === roots.length) return [...roots];
  return [wanted, ...rest];
}

/** Remove one folder; the last one yields an empty list, never a throw. */
export function removeProjectRoot(roots: readonly string[], root: string): string[] {
  return roots.filter((candidate) => candidate !== root);
}

/**
 * Append a picked folder, unless the list already has it.
 *
 * The caller needs to know *why* nothing was added: a duplicate is a sentence
 * next to the picker ("that folder is already in the list"), while a blank pick
 * is nothing at all.
 */
export function appendProjectRoot(
  roots: readonly string[],
  candidate: string,
): { roots: string[]; duplicate: boolean } {
  const root = candidate.trim();
  if (!root) return { roots: [...roots], duplicate: false };
  if (roots.includes(root)) return { roots: [...roots], duplicate: true };
  return { roots: [...roots, root], duplicate: false };
}

/** How much of a root a row shows before the middle gives way. */
const PATH_BUDGET = 44;

/**
 * Middle-truncate a path, keeping its basename visible.
 *
 * A plain ellipsis eats the ending, and the ending is the part that tells two
 * folders apart. The head still says where it lives; the full path stays in the
 * row's title and, when this shortens anything, in the screen reader's text.
 */
export function middleEllipsis(path: string, budget = PATH_BUDGET): string {
  if (path.length <= budget) return path;
  const basenameAt = path.lastIndexOf("/");
  const parentAt = path.lastIndexOf("/", basenameAt - 1);
  const tailStart = budget - 12;
  const twoSegments = parentAt > 0 ? path.slice(parentAt) : "";
  const tail =
    twoSegments && twoSegments.length <= tailStart ? twoSegments : path.slice(-tailStart);
  return `${path.slice(0, Math.max(1, budget - tail.length - 1))}…${tail}`;
}
