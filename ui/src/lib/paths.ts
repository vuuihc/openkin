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

function slashPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function trimTrailingSlash(input: string): string {
  return input.replace(/\/+$/, "");
}

export function normalizeRelativePath(input: string): string | null {
  const raw = slashPath(input).trim();
  if (!raw) return null;
  const parts = raw.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join("/") || ".";
}

export function toWorkspaceRelativePath(cwd: string, filePath: string): string | null {
  const raw = filePath.trim();
  if (!raw) return null;

  const normalizedCwd = trimTrailingSlash(slashPath(cwd));
  const normalizedPath = slashPath(raw);
  const compareCwd = normalizedCwd.toLowerCase();
  const comparePath = trimTrailingSlash(normalizedPath).toLowerCase();

  if (comparePath === compareCwd) return ".";
  if (comparePath.startsWith(compareCwd + "/")) {
    return normalizeRelativePath(normalizedPath.slice(normalizedCwd.length + 1));
  }
  if (
    normalizedPath.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalizedPath) ||
    normalizedPath.startsWith("//")
  ) {
    return null;
  }
  return normalizeRelativePath(normalizedPath);
}
