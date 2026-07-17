/** Project/cwd helpers for sidebar grouping. */

export function projectLabel(cwd: string): string {
  if (!cwd) return "unknown";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

export function shortPath(path: string, max = 36): string {
  if (path.length <= max) return path;
  return "…" + path.slice(-(max - 1));
}
