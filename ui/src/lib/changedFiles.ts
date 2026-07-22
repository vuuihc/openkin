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
  /**
   * Best-effort line deltas reconstructed from tool inputs.
   * Undefined when the tool payload has no reconstructible body.
   */
  additions?: number;
  deletions?: number;
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
 * Collect workspace file paths mutated by tools in a task event stream.
 * Read-only tools are ignored — the review UI only tracks writes/edits/deletes.
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

    // Line deltas are per tool call; attribute to each touched path.
    const delta = lineDeltaFromTool(name, input);
    for (const rawPath of collectPaths(input, name)) {
      const path = rawPath.trim();
      if (!path || path === "." || path === "/") continue;
      const action = actionForTool(name, path, input);
      const key = path.replace(/\\/g, "/");
      const prev = byPath.get(key);
      // Prefer write/edit over read when the same path is seen multiple times.
      if (prev && rank(prev.action) > rank(action) && prev.seq >= ev.seq) {
        // Still accumulate stats from weaker later events? Skip entirely.
        continue;
      }
      if (prev && rank(prev.action) > rank(action)) {
        // Keep stronger action but still accumulate deltas / refresh metadata.
        if (ev.seq >= prev.seq) {
          byPath.set(key, {
            ...prev,
            seq: ev.seq,
            tool: name || prev.tool,
            ...mergeDelta(prev, delta),
          });
        }
        continue;
      }
      byPath.set(key, {
        path: prev?.path ?? path,
        action,
        tool: name || prev?.tool || "tool",
        seq: Math.max(prev?.seq ?? 0, ev.seq),
        ...mergeDelta(prev, delta),
      });
    }
  }

  // Only surface mutations (write/edit/delete). Reads are intentionally
  // omitted from task file stats / review UI.
  const list = Array.from(byPath.values()).filter(
    (f) => f.action !== "read" && f.action !== "other",
  );
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



function mergeDelta(
  prev: ChangedFile | undefined,
  delta: { additions: number; deletions: number } | null,
): { additions?: number; deletions?: number } {
  if (!delta) {
    return {
      additions: prev?.additions,
      deletions: prev?.deletions,
    };
  }
  return {
    additions: (prev?.additions ?? 0) + delta.additions,
    deletions: (prev?.deletions ?? 0) + delta.deletions,
  };
}

/** Count lines in a string; a trailing final newline does not add an extra line. */
export function countLines(text: string): number {
  if (!text) return 0;
  const parts = text.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

/**
 * Estimate added/deleted lines from a tool input payload.
 * Returns null when nothing reconstructible is present.
 */
export function lineDeltaFromTool(
  toolName: string,
  input: unknown,
): { additions: number; deletions: number } | null {
  const rec = asRecord(input);
  if (!rec) return null;
  const n = toolName.toLowerCase();

  // Unified patch / diff text.
  const patch =
    typeof rec.patch === "string"
      ? rec.patch
      : typeof rec.diff === "string"
        ? rec.diff
        : null;
  if (
    patch &&
    (patch.includes("\n+") ||
      patch.includes("\n-") ||
      patch.startsWith("@@") ||
      patch.includes("@@ "))
  ) {
    return deltaFromUnifiedPatch(patch);
  }

  // Full-file write / create → all lines added.
  const full =
    typeof rec.contents === "string"
      ? rec.contents
      : typeof rec.content === "string"
        ? rec.content
        : typeof rec.new_content === "string"
          ? rec.new_content
          : typeof rec.text === "string" && (n.includes("write") || n === "create_file")
            ? rec.text
            : null;
  if (
    full != null &&
    (n.includes("write") || n === "create_file" || n === "write_file")
  ) {
    return { additions: countLines(full), deletions: 0 };
  }

  // Delete tool.
  if (n.includes("delete") || n.includes("remove") || n === "rm") {
    if (typeof rec.content === "string") {
      return { additions: 0, deletions: countLines(rec.content) };
    }
    return { additions: 0, deletions: 0 };
  }

  // Single str_replace.
  const oldS =
    typeof rec.old_string === "string"
      ? rec.old_string
      : typeof rec.old_str === "string"
        ? rec.old_str
        : typeof rec.oldText === "string"
          ? rec.oldText
          : typeof rec.before === "string"
            ? rec.before
            : null;
  const newS =
    typeof rec.new_string === "string"
      ? rec.new_string
      : typeof rec.new_str === "string"
        ? rec.new_str
        : typeof rec.newText === "string"
          ? rec.newText
          : typeof rec.after === "string"
            ? rec.after
            : null;
  if (oldS != null && newS != null) {
    return { additions: countLines(newS), deletions: countLines(oldS) };
  }

  // Multi-edit arrays.
  const edits = Array.isArray(rec.edits)
    ? rec.edits
    : Array.isArray(rec.replacements)
      ? rec.replacements
      : null;
  if (edits && edits.length > 0) {
    let additions = 0;
    let deletions = 0;
    let any = false;
    for (const raw of edits) {
      const e = asRecord(raw);
      if (!e) continue;
      const o =
        typeof e.old_string === "string"
          ? e.old_string
          : typeof e.old_str === "string"
            ? e.old_str
            : typeof e.before === "string"
              ? e.before
              : null;
      const nw =
        typeof e.new_string === "string"
          ? e.new_string
          : typeof e.new_str === "string"
            ? e.new_str
            : typeof e.after === "string"
              ? e.after
              : null;
      if (o != null && nw != null) {
        additions += countLines(nw);
        deletions += countLines(o);
        any = true;
      }
    }
    if (any) return { additions, deletions };
  }

  return null;
}

function deltaFromUnifiedPatch(
  patch: string,
): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("@@")
    ) {
      continue;
    }
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

/** Aggregate line stats across a changed-file list. */
export function summarizeChangedFiles(files: ChangedFile[]): {
  files: number;
  additions: number;
  deletions: number;
  /** True when at least one file contributed a known delta. */
  hasStats: boolean;
} {
  let additions = 0;
  let deletions = 0;
  let hasStats = false;
  for (const f of files) {
    if (f.additions != null || f.deletions != null) {
      hasStats = true;
      additions += f.additions ?? 0;
      deletions += f.deletions ?? 0;
    }
  }
  return { files: files.length, additions, deletions, hasStats };
}

/** Best-effort single path from a tool input payload (for deep-links). */
export function extractPrimaryToolPath(toolName: string, input: unknown): string | null {
  const paths = collectPaths(input, toolName || "tool");
  return paths[0] ?? null;
}

/** Side-by-side content for Monaco DiffEditor, reconstructed from tool inputs. */
export type FileDiffSnippet = {
  path: string;
  /** Previous content when known (empty string = added file / unknown before). */
  original: string;
  /** New content after the tool edit. */
  modified: string;
  /** How the snippet was derived. */
  source: "write" | "str_replace" | "patch" | "unknown";
};

/**
 * Find the most recent tool_use that mutated `filePath` and rebuild an
 * original/modified pair for diff highlighting.
 *
 * Supports:
 * - write/write_file with full `content`/`contents` (original empty)
 * - edit/str_replace with old_string/new_string (and multi-edit arrays)
 * - unified patch/diff text (best-effort single-file apply)
 */
export function extractFileDiff(
  events: TaskEvent[],
  filePath: string,
): FileDiffSnippet | null {
  const target = normalizePathKey(filePath);
  if (!target) return null;

  // Walk newest → oldest so the latest mutation wins.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev.type !== "tool_use" && ev.type !== "tool_result") continue;
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const content = asRecord(p.content);
    const item = asRecord(p.item);
    const name = String(
      content?.name ?? p.name ?? p.tool_name ?? item?.type ?? item?.name ?? "tool",
    ).trim();
    const input =
      p.input ?? content?.input ?? item?.input ?? item?.changes ?? item ?? content;

    const paths = collectPaths(input, name).map(normalizePathKey);
    if (!paths.some((x) => x === target || x.endsWith("/" + target) || target.endsWith("/" + x))) {
      continue;
    }

    const action = actionForTool(name, filePath, input);
    if (action === "read" || action === "other") continue;

    const snippet = diffFromToolInput(name, input);
    if (!snippet) continue;
    return {
      path: filePath,
      original: snippet.original,
      modified: snippet.modified,
      source: snippet.source,
    };
  }
  return null;
}

function normalizePathKey(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function diffFromToolInput(
  toolName: string,
  input: unknown,
): { original: string; modified: string; source: FileDiffSnippet["source"] } | null {
  const rec = asRecord(input);
  if (!rec) return null;
  const n = toolName.toLowerCase();

  // Full-file write.
  const full =
    typeof rec.contents === "string"
      ? rec.contents
      : typeof rec.content === "string"
        ? rec.content
        : typeof rec.new_content === "string"
          ? rec.new_content
          : typeof rec.text === "string" && (n.includes("write") || n === "create_file")
            ? rec.text
            : null;
  if (full != null && (n.includes("write") || n === "create_file" || n === "write_file")) {
    return { original: "", modified: full, source: "write" };
  }

  // Single str_replace / edit.
  const oldS =
    typeof rec.old_string === "string"
      ? rec.old_string
      : typeof rec.old_str === "string"
        ? rec.old_str
        : typeof rec.oldText === "string"
          ? rec.oldText
          : typeof rec.before === "string"
            ? rec.before
            : null;
  const newS =
    typeof rec.new_string === "string"
      ? rec.new_string
      : typeof rec.new_str === "string"
        ? rec.new_str
        : typeof rec.newText === "string"
          ? rec.newText
          : typeof rec.after === "string"
            ? rec.after
            : null;
  if (oldS != null && newS != null) {
    return { original: oldS, modified: newS, source: "str_replace" };
  }

  // Multi-edit arrays (Claude Code Edit / some agents).
  const edits = Array.isArray(rec.edits)
    ? rec.edits
    : Array.isArray(rec.replacements)
      ? rec.replacements
      : null;
  if (edits && edits.length > 0) {
    const partsOld: string[] = [];
    const partsNew: string[] = [];
    for (const raw of edits) {
      const e = asRecord(raw);
      if (!e) continue;
      const o =
        typeof e.old_string === "string"
          ? e.old_string
          : typeof e.old_str === "string"
            ? e.old_str
            : typeof e.before === "string"
              ? e.before
              : null;
      const nw =
        typeof e.new_string === "string"
          ? e.new_string
          : typeof e.new_str === "string"
            ? e.new_str
            : typeof e.after === "string"
              ? e.after
              : null;
      if (o != null && nw != null) {
        partsOld.push(o);
        partsNew.push(nw);
      }
    }
    if (partsOld.length > 0) {
      return {
        original: partsOld.join("\n\n---\n\n"),
        modified: partsNew.join("\n\n---\n\n"),
        source: "str_replace",
      };
    }
  }

  // Unified patch/diff body — show as modified-only with empty original so
  // DiffEditor still colorizes +/– lines poorly; better: put patch on modified.
  const patch =
    typeof rec.patch === "string"
      ? rec.patch
      : typeof rec.diff === "string"
        ? rec.diff
        : null;
  if (patch && patch.includes("@@")) {
    const applied = applyUnifiedPatchSides(patch);
    if (applied) return { ...applied, source: "patch" };
    return { original: "", modified: patch, source: "patch" };
  }

  return null;
}

/**
 * Best-effort: rebuild pre/post file text from a single-file unified diff.
 * Only handles simple hunks without renames; failures return null.
 */
function applyUnifiedPatchSides(
  patch: string,
): { original: string; modified: string } | null {
  const orig: string[] = [];
  const mod: string[] = [];
  let sawHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      continue;
    }
    if (line.startsWith("@@")) {
      sawHunk = true;
      continue;
    }
    if (!sawHunk) continue;
    if (line.startsWith("+")) {
      mod.push(line.slice(1));
    } else if (line.startsWith("-")) {
      orig.push(line.slice(1));
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file"
      continue;
    } else {
      // context line (may start with a space)
      const body = line.startsWith(" ") ? line.slice(1) : line;
      orig.push(body);
      mod.push(body);
    }
  }
  if (!sawHunk || (orig.length === 0 && mod.length === 0)) return null;
  return { original: orig.join("\n"), modified: mod.join("\n") };
}
