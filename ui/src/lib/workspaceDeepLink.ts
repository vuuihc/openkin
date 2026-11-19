/**
 * The workspace panel's place in the address:
 * `/tasks/<id>?panel=files&file=<path>` or `/tasks/<id>?panel=pr`.
 *
 * The panel has three states sharing one URL shape — conversation (no keys),
 * file list (`panel=files`), one file (`panel=files&file=…`) — and a fourth
 * surface, the pull-request tab (`panel=pr`), which may carry the file the
 * panel remembers. The query belongs to whoever reads it, so this module edits
 * the raw search string as bytes: a neighbouring `%20`, a literal `+`, an
 * unrelated parameter and its position are preserved exactly.
 * `URLSearchParams.toString()` is the wrong tool here: it re-encodes every
 * value it did not have to touch (`%20` becomes `+`), so a link with a space in
 * its filename would change under the reader's feet.
 *
 * The `file` value is untrusted input: it comes from a pasted or forwarded
 * link, and the page resolves whatever it is handed against the task's
 * checkout. It is decoded once and refused unless it is a clean repo-relative
 * path, so an absolute path that happens to sit inside the checkout can never
 * be mistaken for a relative one.
 */

export type WorkspacePanel = "files" | "pr";

export type WorkspaceLink = {
  panel: WorkspacePanel;
  /** A clean repo-relative path, remembered behind PR, or null when absent. */
  file: string | null;
  /**
   * The address itself named the panel. A lone `file` is stale — it names no
   * panel, so it opens nothing and the caller drops it.
   */
  explicit: boolean;
};

type Segment = {
  /** The original bytes of this `key=value` pair. */
  raw: string;
  value: string | null;
  decodedKey: string | null;
};

function segmentsOf(search: string): Segment[] {
  const bare = search.startsWith("?") ? search.slice(1) : search;
  if (!bare) return [];
  return bare.split("&").map((raw) => {
    const eq = raw.indexOf("=");
    const key = eq === -1 ? raw : raw.slice(0, eq);
    const value = eq === -1 ? null : raw.slice(eq + 1);
    return { raw, value, decodedKey: decode(key) };
  });
}

function decode(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/**
 * A path the page may resolve against the checkout, or null.
 *
 * Refused: empty, dot/-dot segments, empty segments (`a//b`), absolute paths,
 * drive letters and URI schemes, backslashes (a Windows separator is an escape
 * on every other host), control characters, and surrounding whitespace. A
 * Unicode filename is fine.
 */
function cleanRelativePath(value: string | null): string | null {
  if (value === null) return null;
  if (value === "" || value !== value.trim()) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  if (value.includes("\\")) return null;
  if (value.startsWith("/")) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return null;
  for (const segment of value.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return null;
  }
  return value;
}

export function parseWorkspaceLink(search: string): WorkspaceLink | null {
  const segments = segmentsOf(search);
  const panel = segments.find((segment) => segment.decodedKey === "panel");
  const file = segments.find((segment) => segment.decodedKey === "file");
  if (!panel) {
    // Only an explicit panel value opens it. A bare `file` is a leftover from a
    // previous state, not an instruction.
    return file ? { panel: "files", file: null, explicit: false } : null;
  }
  const value = decode(panel.value);
  // `panel=publish` (and anything else) is another surface's word.
  if (value !== "files" && value !== "pr") return null;
  return {
    panel: value,
    file: file ? cleanRelativePath(decode(file.value)) : null,
    explicit: true,
  };
}

/** Keep a matched pair's original bytes when its decoded value already agrees. */
function keepOrWrite(segment: Segment, key: string, value: string): string {
  return decode(segment.value) === value ? segment.raw : `${key}=${encodeWorkspacePath(value)}`;
}

/** Percent-encode a path without hiding its separators. */
function encodeWorkspacePath(path: string): string {
  return encodeURIComponent(path).replace(/%2F/gi, "/");
}

export function patchWorkspaceLink(
  search: string,
  next: { panel: WorkspacePanel; file: string | null } | null,
): string {
  const segments = segmentsOf(search);
  const panel = segments.find((segment) => segment.decodedKey === "panel");
  // `panel` is shared with other surfaces. When it names one of theirs, the
  // query is not ours to rewrite.
  const value = panel ? decode(panel.value) : null;
  if (panel && value !== "files" && value !== "pr") return search;

  const parts: string[] = [];
  let sawPanel = false;
  let sawFile = false;
  for (const segment of segments) {
    if (segment.decodedKey === "panel") {
      if (sawPanel) continue;
      sawPanel = true;
      if (next) parts.push(keepOrWrite(segment, "panel", next.panel));
      continue;
    }
    if (segment.decodedKey === "file") {
      if (sawFile) continue;
      sawFile = true;
      if (next?.file != null) {
        parts.push(keepOrWrite(segment, "file", next.file));
      } else if (next?.panel === "pr") {
        // The PR tab remembers the file without opening it: switching surfaces
        // keeps the reader's place, so the pair stays exactly as it was.
        parts.push(segment.raw);
      }
      continue;
    }
    parts.push(segment.raw);
  }
  if (next) {
    if (!sawPanel) parts.push(`panel=${next.panel}`);
    if (!sawFile && next.file != null) {
      parts.push(`file=${encodeWorkspacePath(next.file)}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/** Remove one key, leaving every other pair's bytes and order alone. */
export function dropSearchParam(search: string, name: string): string {
  const segments = segmentsOf(search);
  const kept = segments.filter((segment) => segment.decodedKey !== name);
  if (kept.length === segments.length) return search;
  return kept.length ? `?${kept.map((segment) => segment.raw).join("&")}` : "";
}
