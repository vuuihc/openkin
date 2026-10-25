/**
 * What one round changed, read from the events behind it.
 *
 * The input is the same slice the console already draws: a round of turns and
 * the seq range they cover. Everything here comes out of that slice, which is
 * the property worth keeping — the previews are read from the same events as the
 * counts, so a later round's edit to the same file cannot leak into this one's
 * card.
 *
 * "Changed" means changed through a file tool. An agent's shell commands are not
 * in here, and cannot be: nothing in the stream says which paths they touched.
 * That is why this is called evidence and why it does not claim to be the
 * workspace diff.
 */
import type { TaskEvent } from "../api/client";
import {
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
};

export const ROUND_EVIDENCE_MAX_FILES = 6;

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
