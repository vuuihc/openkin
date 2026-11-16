/** In-memory helpers for Chrome-tab style session keep-alive. */

/** How many recently opened sessions stay mounted. */
export const MAX_CACHED_SESSIONS = 8;

/** Move taskId to front; drop oldest past max. Empty id is a no-op. */
export function touchSessionCache(
  prev: string[],
  taskId: string,
  max = MAX_CACHED_SESSIONS,
): string[] {
  if (!taskId) return prev;
  const next = [taskId, ...prev.filter((x) => x !== taskId)];
  return next.slice(0, max);
}

export function dropSessionCache(prev: string[], taskId: string): string[] {
  if (!taskId) return prev;
  return prev.filter((x) => x !== taskId);
}

/** `/tasks/:id` → id; other paths → null. */
export function taskIdFromPathname(pathname: string): string | null {
  const m = pathname.match(/^\/tasks\/([^/]+)\/?$/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}
