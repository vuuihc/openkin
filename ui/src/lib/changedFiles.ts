import type { TaskEvent } from "../api/client";

export type ChangedFileAction = "write" | "edit" | "delete" | "read" | "other";

export type ChangedFile = {
  /** Raw path as seen in the event (abs or rel). */
  path: string;
  action: ChangedFileAction;
  /** Last tool name that touched this path. */
  tool: string;
  /** Last event seq (higher = more recent). */
  seq: number;
};

/** Tools that mutate (or clearly target) workspace files. */
const WRITE_TOOLS = new Set([
  "write_file",
  "write",
  "edit",
  "edit_file",
  "apply_patch",
  "strreplace",
  "str_replace",
  "str_replace_editor",
  "delete",
  "delete_file",
  "remove",
  "create_file",
  "notebookedit",
  "notebook_edit",
]);

const READ_TOOLS = new Set(["read_file", "read", "view"]);

/**
 * Collect workspace file paths touched by tools in a task event stream.
 * Prefers mutation tools; falls back to reads so the bar is still useful
 * when the agent only inspected files.
 */
export function extractChangedFiles(events: TaskEvent[]): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();

  for (const ev of events) {
    if (ev.type !== "tool_use" && ev.type !== "tool_result") continue;
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const content = asRecord(p.content);
    const item = asRecord(p.item);
    const name = String(
      content?.name ??
        p.name ??
        p.tool_name ??
        item?.type ??
        item?.name ??
        "tool",
    ).trim();
    const input =
      p.input ??
      content?.input ??
      item?.input ??
      item?.changes ??
      item ??
      content;

    for (const rawPath of collectPaths(input, name)) {
      const path = rawPath.trim();
      if (!path || path === "." || path === "/") continue;
      const action = actionForTool(name, path, input);
      const key = path.replace(/\\/g, "/");
      const prev = byPath.get(key);
      // Prefer write/edit over read when the same path is seen multiple times.
      if (prev && rank(prev.action) > rank(action) && prev.seq >= ev.seq) {
        continue;
      }
      if (prev && rank(prev.action) > rank(action)) {
        // Keep stronger action but refresh seq/tool if newer.
        if (ev.seq >= prev.seq) {
          byPath.set(key, { ...prev, seq: ev.seq, tool: name || prev.tool });
        }
        continue;
      }
      byPath.set(key, {
        path,
        action,
        tool: name || "tool",
        seq: ev.seq,
      });
    }
  }

  const all = Array.from(byPath.values());
  const mutated = all.filter((f) => f.action !== "read" && f.action !== "other");
  const list = mutated.length > 0 ? mutated : all.filter((f) => f.action === "read");
  list.sort((a, b) => b.seq - a.seq || a.path.localeCompare(b.path));
  return list;
}

function rank(action: ChangedFileAction): number {
  switch (action) {
    case "delete":
      return 4;
    case "write":
      return 3;
    case "edit":
      return 2;
    case "read":
      return 1;
    default:
      return 0;
  }
}

function actionForTool(
  name: string,
  _path: string,
  input: unknown,
): ChangedFileAction {
  const n = name.toLowerCase();
  if (
    n.includes("delete") ||
    n.includes("remove") ||
    n === "rm"
  ) {
    return "delete";
  }
  if (WRITE_TOOLS.has(n) || n.includes("write") || n.includes("create")) {
    return "write";
  }
  if (
    n.includes("edit") ||
    n.includes("replace") ||
    n.includes("patch") ||
    n === "file_change"
  ) {
    return "edit";
  }
  // Codex-style file_change items often carry a changes array with kind.
  const rec = asRecord(input);
  const changes = rec?.changes;
  if (Array.isArray(changes) && changes.length > 0) {
    return "edit";
  }
  if (READ_TOOLS.has(n) || n.includes("read") || n.includes("view")) {
    return "read";
  }
  return "other";
}

function collectPaths(input: unknown, toolName: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v !== "string") return;
    const s = v.trim();
    if (!s || seen.has(s)) return;
    // Ignore obvious non-paths (shell commands without slash/dot).
    if (s.length > 512) return;
    seen.add(s);
    out.push(s);
  };

  const rec = asRecord(input);
  if (!rec) {
    // Sometimes input is a bare path string.
    if (typeof input === "string" && looksLikePath(input)) add(input);
    return out;
  }

  // Common single-path fields.
  for (const key of [
    "path",
    "file_path",
    "filePath",
    "file",
    "filename",
    "target",
    "target_file",
    "targetFile",
  ]) {
    add(rec[key]);
  }

  // Multi-path fields.
  for (const key of ["paths", "files", "file_paths"]) {
    const arr = rec[key];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (typeof item === "string") add(item);
        else {
          const r = asRecord(item);
          if (r) {
            add(r.path);
            add(r.file_path);
            add(r.filePath);
          }
        }
      }
    }
  }

  // Codex / structured change lists: [{ path, kind }]
  if (Array.isArray(rec.changes)) {
    for (const c of rec.changes) {
      const r = asRecord(c);
      if (r) {
        add(r.path);
        add(r.file_path);
        add(r.filePath);
      }
    }
  }

  // Nested item.changes from some adapters when whole item was passed as input.
  if (Array.isArray(rec.item) === false) {
    const item = asRecord(rec.item);
    if (item && Array.isArray(item.changes)) {
      for (const c of item.changes) {
        const r = asRecord(c);
        if (r) add(r.path ?? r.file_path ?? r.filePath);
      }
    }
  }

  // Apply-patch style: try to scrape *** Update File: path lines from patch text.
  const patch =
    typeof rec.patch === "string"
      ? rec.patch
      : typeof rec.diff === "string"
        ? rec.diff
        : typeof rec.content === "string" && toolName.toLowerCase().includes("patch")
          ? rec.content
          : null;
  if (patch) {
    for (const line of patch.split("\n")) {
      const m =
        /^\*\*\*\s+(?:Add|Update|Delete|Rename)\s+File:\s+(.+)\s*$/i.exec(line) ||
        /^diff --git a\/(.+?) b\//.exec(line) ||
        /^\+\+\+\s+b\/(.+)\s*$/.exec(line);
      if (m?.[1] && m[1] !== "/dev/null") add(m[1].trim());
    }
  }

  return out;
}

function looksLikePath(s: string): boolean {
  const t = s.trim();
  if (!t || /\s{2,}/.test(t)) return false;
  if (t.startsWith("-")) return false;
  return t.includes("/") || t.includes("\\") || /\.[A-Za-z0-9]{1,8}$/.test(t);
}

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}


/** Best-effort single path from a tool input payload (for deep-links). */
export function extractPrimaryToolPath(toolName: string, input: unknown): string | null {
  const paths = collectPaths(input, toolName || "tool");
  return paths[0] ?? null;
}
