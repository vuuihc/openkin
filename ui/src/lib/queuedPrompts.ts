import { ApiError, type QueuedPrompt } from "../api/client";

/**
 * The seqs of the messages in the transcript that are still waiting for an
 * answer.
 *
 * The message itself is already in the transcript — it was written there when it
 * was accepted — so this is the only thing that changes when a prompt is queued
 * or answered: which seqs the transcript marks as waiting. A queued prompt with
 * `user_seq = 0` was accepted when its event write failed, so there is nothing in
 * the transcript to mark; the delivery writes the event then.
 */
export function queuedMessageSeqs(prompts: QueuedPrompt[]): Set<number> {
  const waiting = new Set<number>();
  for (const prompt of prompts) {
    if (typeof prompt.user_seq === "number" && prompt.user_seq > 0) {
      waiting.add(prompt.user_seq);
    }
  }
  return waiting;
}

/** True when this transcript message is one of the ones still waiting. */
export function isMessageQueued(seq: number | undefined, waiting: Set<number>): boolean {
  return typeof seq === "number" && waiting.has(seq);
}

/**
 * The queue with the rows a withdrawal has already taken out.
 *
 * The queue poll and a withdrawal can be in flight together: a list the daemon
 * built before the delete landed arrives after the badge was removed and puts
 * the row back, so the badge reappears under the tap that removed it. Row ids
 * are never reused, so a withdrawn row stays out for the life of the page — this
 * is why the caller keeps the mark after the request succeeds rather than only
 * while it is in flight.
 */
export function withoutWithdrawn(
  prompts: QueuedPrompt[],
  withdrawn: ReadonlySet<number>,
): QueuedPrompt[] {
  if (withdrawn.size === 0) return prompts;
  return prompts.filter((prompt) => !withdrawn.has(prompt.id));
}

/**
 * Start withdrawing the queued message with this seq and return the row that is
 * being taken back, or null when nothing in the queue matches.
 *
 * The caller drops the row at once — the tap should not wait for a round trip,
 * and the poll that follows confirms it. A 404 is the answer we wanted: the turn
 * boundary took the row, or another device withdrew it first, so the message is
 * not queued any more either way and nothing is reported. Any other failure
 * means the message is still waiting, so the id is un-marked (a later list may
 * bring the badge back) and `onError` says what happened.
 *
 * `withdrawn` is the caller's set of ids taken back; it keeps the mark after
 * success, which is what stops a poll answered before the delete landed from
 * resurrecting the row.
 */
export function startWithdrawal(args: {
  queue: QueuedPrompt[];
  seq: number;
  withdrawn: Set<number>;
  request: (promptID: number) => Promise<void>;
  onError: (err: unknown) => void;
}): QueuedPrompt | null {
  const queued = args.queue.find((prompt) => prompt.user_seq === args.seq);
  if (!queued) return null;
  args.withdrawn.add(queued.id);
  args.request(queued.id).catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 404) return;
    args.withdrawn.delete(queued.id);
    args.onError(err);
  });
  return queued;
}
