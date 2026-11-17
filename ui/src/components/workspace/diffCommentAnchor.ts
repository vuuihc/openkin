/**
 * KIN-RESULT-003 — where a diff comment points, and how a tray of comments
 * becomes one ordinary follow-up message.
 *
 * The anchor is data, not a DOM position: file path, hunk header, quoted line
 * and modified line number. That is what lets part 2 re-place a comment after
 * the agent reruns and the line numbers move — the quote and the hunk header
 * survive a re-render, a file switch and a reload; a pixel offset does not.
 *
 * Nothing here touches the network or a diff library: the hunk header is
 * formatted from Monaco's own `getLineChanges()` blocks, and the quote is the
 * one line the person pointed at.
 */

/** One changed block, as Monaco's `getLineChanges()` reports it. */
export type LineChange = {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
};

/** What a comment points at. Data only — see the part-2 note below. */
export type DiffAnchor = {
  path: string;
  /** The unified-diff header for the block, e.g. `@@ -10,3 +10,4 @@`. */
  hunkHeader: string;
  /** The modified line's text, trailing whitespace trimmed. */
  quote: string;
  /** 1-based line number in the modified file. */
  line: number;
};

/** A saved comment: its anchor plus the person's words. */
export type DiffComment = DiffAnchor & {
  id: string;
  text: string;
  createdAt: number;
};

/** The slice of `Storage` the adapter needs, so the pure tests can supply one. */
export type CommentStorage = Pick<Storage, "getItem" | "setItem">;

const STORAGE_PREFIX = "kin.diffComments.";

/** `kin.diffComments.<taskId>` — comments belong to one conversation. */
export function commentsStorageKey(taskId: string): string {
  return `${STORAGE_PREFIX}${taskId}`;
}

function defaultStorage(): CommentStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function side(start: number, end: number): { start: number; count: number } {
  // Monaco marks an empty side with `end === 0`; the public start is then the
  // line *before* the change, which is exactly what a unified header prints.
  return { start, count: end === 0 ? 0 : Math.max(0, end - start + 1) };
}

/** `@@ -oStart,oCount +mStart,mCount @@` for one changed block. */
export function formatHunkHeader(change: LineChange): string {
  const original = side(change.originalStartLineNumber, change.originalEndLineNumber);
  const modified = side(change.modifiedStartLineNumber, change.modifiedEndLineNumber);
  return `@@ -${original.start},${original.count} +${modified.start},${modified.count} @@`;
}

/** The quote for a line: its text with trailing whitespace removed. */
export function quoteLine(text: string): string {
  return text.replace(/\s+$/, "");
}

/** Whether `line` (1-based, modified file) sits inside a commentable change. */
export function isChangedLine(lineChanges: readonly LineChange[] | null, line: number): boolean {
  if (!lineChanges || line < 1) return false;
  return lineChanges.some(
    (change) =>
      change.modifiedEndLineNumber !== 0 &&
      line >= change.modifiedStartLineNumber &&
      line <= change.modifiedEndLineNumber,
  );
}

/**
 * The anchor for `line`, or null when that line is not part of a change.
 *
 * `lineContent` is the modified line's own text, read from the editor model —
 * the caller already has it, so no diff or line split is repeated here.
 */
export function anchorForLine(input: {
  path: string;
  line: number;
  lineContent: string;
  lineChanges: readonly LineChange[] | null;
}): DiffAnchor | null {
  const { path, line, lineContent, lineChanges } = input;
  if (!lineChanges) return null;
  const change = lineChanges.find(
    (candidate) =>
      candidate.modifiedEndLineNumber !== 0 &&
      line >= candidate.modifiedStartLineNumber &&
      line <= candidate.modifiedEndLineNumber,
  );
  if (!change) return null;
  return {
    path,
    hunkHeader: formatHunkHeader(change),
    quote: quoteLine(lineContent),
    line,
  };
}

/** One comment as the paragraph it becomes in the follow-up message. */
export function formatCommentBlock(comment: DiffComment): string {
  return [
    `${comment.path}:${comment.line}`,
    comment.hunkHeader,
    `> ${comment.quote}`,
    "",
    comment.text,
  ].join("\n");
}

/**
 * The single follow-up message for a tray: one short sentence, then one
 * paragraph per comment. The person's words are copied verbatim.
 */
export function formatDiffCommentsMessage(
  comments: readonly DiffComment[],
  intro: string,
): string {
  if (comments.length === 0) return intro;
  return `${intro}\n\n${comments.map(formatCommentBlock).join("\n\n")}`;
}

function isComment(value: unknown): value is DiffComment {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.path === "string" &&
    typeof item.hunkHeader === "string" &&
    typeof item.quote === "string" &&
    typeof item.line === "number" &&
    typeof item.text === "string" &&
    typeof item.createdAt === "number"
  );
}

/**
 * What was stored for this conversation.
 *
 * Absent, unreadable or corrupt JSON reads as no comments: a broken store must
 * never keep the person out of their diff, and an entry that is not shaped
 * like a comment is dropped rather than trusted.
 */
export function readDiffComments(
  taskId: string,
  storage: CommentStorage | null = defaultStorage(),
): DiffComment[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(commentsStorageKey(taskId));
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isComment);
}

/** Persist the tray for one conversation. A storage failure is not fatal. */
export function writeDiffComments(
  taskId: string,
  comments: readonly DiffComment[],
  storage: CommentStorage | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(commentsStorageKey(taskId), JSON.stringify(comments));
  } catch {
    // A full or blocked store leaves the tray working for this visit.
  }
}

/** A stable-enough id for one comment; no server ever sees it. */
export function newCommentId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `dc_${Date.now().toString(36)}_${random}`;
}

// part 2: re-anchoring against a fresh diff goes here — match a saved anchor to
// a changed block by hunk header, then by quote, and mark it stale when the
// quoted line is gone. Keep it a function of (anchor, lineChanges, lines), not
// of the editor, so the tray can render the same answer without Monaco.
