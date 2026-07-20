/** Project/cwd helpers for sidebar grouping. */

export function projectLabel(cwd: string): string {
  if (!cwd) return "unknown";
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

export function shortPath(path: string | null | undefined, max = 36): string {
  const p = path ?? "";
  if (p.length <= max) return p;
  return "…" + p.slice(-(max - 1));
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

/** Join task cwd/root with a workspace-relative path into an absolute path. */
export function toAbsoluteWorkspacePath(
  root: string,
  relativePath: string | null | undefined,
): string | null {
  if (!root) return null;
  const base = trimTrailingSlash(slashPath(root));
  if (!relativePath || relativePath === "." || relativePath === "./") {
    return base || null;
  }
  // Refuse absolute / drive inputs before normalizing.
  const slashRel = slashPath(relativePath.trim());
  if (
    slashRel.startsWith("/") ||
    /^[A-Za-z]:\//.test(slashRel) ||
    slashRel.startsWith("//")
  ) {
    return null;
  }
  const rel = normalizeRelativePath(relativePath);
  // null means the path escaped above root (e.g. "../x").
  if (rel == null) return null;
  if (rel === ".") return base || null;
  return `${base}/${rel}`;
}

