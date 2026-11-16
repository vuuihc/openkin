/**
 * What one round changed, and where that answer came from.
 *
 * Two sources, strongest first:
 *
 * - a record the daemon wrote when the next turn captured its checkpoint: the
 *   files git reports between two snapshots of the disk, so a `sed`, a
 *   formatter or a generator is in the list. See `recordedRounds`.
 * - the events behind the round: everything the file tools said they changed.
 *   This is the fallback for a shared checkout (no checkpoints), a task that
 *   ran on another machine, a session older than the record, and the newest
 *   round, whose closing checkpoint does not exist yet.
 *
 * The payload source is a slice of the transcript, which is the property worth
 * keeping about it — the previews are read from the same events as the counts,
 * so a later round's edit to the same file cannot leak into this one's card.
 * The recorded source carries payload events too, for the previews of the files
 * both sources know about.
 */
import type { TaskEvent, WorkspaceChange } from "../api/client";
import {
  changedFilesFromDiff,
  extractChangedFiles,
  extractFileDiff,
  summarizeChangedFiles,
  type ChangedFile,
} from "./changedFiles";
import { previewFromTexts, type DiffPreview, type PreviewOptions } from "./diffPreview";

export type RoundEvidence = {
  /** The files to list, newest change first. Capped — see `totalFiles`. */
  files: ChangedFile[];
  /** How many files the round touched in all, so a capped list can say so. */
  totalFiles: number;
  additions: number;
  deletions: number;
  /** True when at least one file contributed a known delta. */
  hasStats: boolean;
  /** The events the two sides of every preview are read from. */
  events: TaskEvent[];
  /**
   * Where the list came from. `workspace` means the daemon compared the two
   * checkpoints that bracket the round — the disk's answer, shell commands
   * included. `tools` means it was reconstructed from what the file tools said
   * they did, which is the fallback for shared checkouts and older sessions.
   */
  source: "workspace" | "tools";
};

export const ROUND_EVIDENCE_MAX_FILES = 6;

/**
 * The rounds the daemon wrote down, keyed by the user message that started
 * them.
 *
 * A record is written when the next turn captures its checkpoint, so it
 * describes a finished round: both of its boundaries are snapshots of the disk
 * rather than claims from a tool. A record whose key does not match any round
 * in view (a truncated stream, a retried turn) is simply never read.
 *
 * The last record for a key wins. A retried turn rewrites the record for the
 * round before it, and the rewritten one describes the timeline the reader is
 * looking at.
 */
export function recordedRounds(events: TaskEvent[]): Map<number, WorkspaceChange[]> {
  const out = new Map<number, WorkspaceChange[]>();
  for (const event of events) {
    if (event.type !== "round_changed") continue;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const fromSeq = payload.from_seq;
    if (typeof fromSeq !== "number") continue;
    const raw = Array.isArray(payload.files) ? payload.files : [];
    const changes: WorkspaceChange[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const file = entry as Record<string, unknown>;
      if (typeof file.path !== "string" || typeof file.status !== "string") continue;
      changes.push({
        path: file.path,
        status: file.status as WorkspaceChange["status"],
        ...(typeof file.old_path === "string" ? { old_path: file.old_path } : {}),
        ...(typeof file.additions === "number" ? { additions: file.additions } : {}),
        ...(typeof file.deletions === "number" ? { deletions: file.deletions } : {}),
        ...(file.binary === true ? { binary: true } : {}),
      });
    }
    out.set(fromSeq, changes);
  }
  return out;
}

/**
 * Evidence for a round the daemon recorded, or null when the record says the
 * round changed nothing.
 *
 * An empty record is not a missing one: the two checkpoints agree, so the
 * round left the workspace as it found it (a write the next turn reverted, a
 * command that touched nothing). Falling back to the tool payloads there would
 * put files on screen that are not changed any more.
 *
 * The events are still handed over for the previews: a file the record lists
 * *and* a tool reported can show its before/after exactly as before, and only
 * the record-only files — the shell edits — fall back to "nothing
 * reconstructible".
 */
export function recordedRoundEvidence(
  changes: WorkspaceChange[] | undefined,
  events: TaskEvent[],
  options: { maxFiles?: number } = {},
): RoundEvidence | null {
  if (!changes || changes.length === 0) return null;
  const files = changedFilesFromDiff(null, null, changes);
  const stats = summarizeChangedFiles(files);
  const maxFiles = options.maxFiles ?? ROUND_EVIDENCE_MAX_FILES;
  return {
    files: files.slice(0, maxFiles),
    totalFiles: files.length,
    additions: stats.additions,
    deletions: stats.deletions,
    hasStats: stats.hasStats,
    events,
    source: "workspace",
  };
}

/**
 * Evidence for one round, or null when there is nothing to show.
 *
 * Null covers both cases the card must not be drawn for, and it is deliberate
 * that they are one answer: a round with no seq range (nothing behind it carried
 * one — a stream still in flight) and a round that changed nothing with a file
 * tool. Guessing at either would put a card on screen that claims more than the
 * stream says.
 */
export function roundEvidence(
  events: TaskEvent[],
  range: { fromSeq?: number; toSeq?: number },
  options: { maxFiles?: number } = {},
): RoundEvidence | null {
  const { fromSeq, toSeq } = range;
  if (fromSeq === undefined || toSeq === undefined) return null;
  const slice = events.filter((event) => event.seq >= fromSeq && event.seq <= toSeq);
  if (slice.length === 0) return null;

  const files = extractChangedFiles(slice);
  if (files.length === 0) return null;

  const stats = summarizeChangedFiles(files);
  const maxFiles = options.maxFiles ?? ROUND_EVIDENCE_MAX_FILES;
  return {
    files: files.slice(0, maxFiles),
    totalFiles: files.length,
    additions: stats.additions,
    deletions: stats.deletions,
    hasStats: stats.hasStats,
    events: slice,
    source: "tools",
  };
}

/**
 * The change to show for one file of a round, or null when the payload cannot
 * support one.
 *
 * Within the round the *last* change to a file is the one drawn: `extractFileDiff`
 * walks the slice backwards, and one file edited three times has one before/after
 * pair to show, not three. The counts beside it cover all three, so the preview
 * is a look at the change rather than a ledger of it.
 */
export function evidenceFilePreview(
  evidence: RoundEvidence,
  path: string,
  options: PreviewOptions = {},
): DiffPreview | null {
  const snippet = extractFileDiff(evidence.events, path);
  if (!snippet) return null;
  return previewFromTexts(snippet.original, snippet.modified, options);
}
