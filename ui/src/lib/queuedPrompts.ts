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
 * and the poll that follows confirms it. A 404 is the answer we wanted for a
 * withdrawal: the turn boundary took the row, or another device withdrew it
 * first, so the message is not queued any more either way and nothing is
 * reported. Any other failure means the message is still waiting, so the id is
 * un-marked (a later list may bring the badge back) and `onError` says what
 * happened.
 *
 * An edit cannot use this: it has to tell "withdrawn" from "already running",
 * and a 404 does not, so `startEdit` asks the daemon itself and refills only on
 * an answer that says the row was deleted.
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

/**
 * Whether the composer is free to be filled with a queued message.
 *
 * Refilling replaces what is in the composer, and an edit is a deliberate tap on
 * one particular message — not a reason to throw away something the person was
 * already writing. So the refill waits until there is nothing there to lose.
 */
export function canRefillComposer(draft: { prompt: string; attachments: unknown[] }): boolean {
  return draft.prompt.trim() === "" && draft.attachments.length === 0;
}

/** How an edit ended, for the page that has to say something about it. */
export type EditOutcome =
  /** The daemon deleted the row: its text can go back into the composer. */
  | { kind: "withdrawn" }
  /** The row was gone before the delete reached it, so it may be running. */
  | { kind: "gone" }
  /** It is still queued; `queue` is the daemon's list, row included. */
  | { kind: "stillQueued"; queue: QueuedPrompt[] }
  /** The request failed, and the queue could not be asked either. */
  | { kind: "unknown" };

/** How long an edit request is worth waiting for before another tap is allowed. */
export const EDIT_IN_FLIGHT_MS = 20_000;

/**
 * Whether an edit that started at `startedAt` (ms, 0 for none) still holds the
 * pencil.
 *
 * A deadline rather than a flag: `apiFetch` has no timeout, so a request the
 * network dropped would otherwise refuse every tap for the life of the page.
 * Long enough for a slow delete, short enough that a person who has moved on is
 * not locked out.
 */
export function editStillRunning(startedAt: number, now: number): boolean {
  return startedAt !== 0 && now - startedAt < EDIT_IN_FLIGHT_MS;
}

/**
 * Take a queued message back so it can be edited, and say how it ended.
 *
 * This is not `startWithdrawal`, because an edit needs an answer the × does not:
 * *whether the row was withdrawn or had already been taken by the turn
 * boundary*. A 404 from the delete says only that the row was gone — the
 * boundary may have pulled it into the running round — and putting the text
 * back into the composer then would send the message twice. So `withdrawn` is
 * reported only when the daemon answers that it deleted the row; every other
 * ending leaves the text where it can still be copied from.
 *
 * The row is marked withdrawn before the request goes out, exactly as the ×
 * does it: the caller drops the badge at once, and a poll the daemon answered
 * before the delete landed must not put it back. Only a real failure un-marks
 * it — then the message is still queued and the badge belongs on screen.
 */
export function startEdit(args: {
  row: QueuedPrompt;
  withdrawn: Set<number>;
  request: (promptID: number) => Promise<void>;
  /** The queue as the daemon has it now. */
  relist: () => Promise<QueuedPrompt[]>;
  onSettled: (outcome: EditOutcome) => void;
}): void {
  const { row, withdrawn } = args;
  withdrawn.add(row.id);
  args.request(row.id).then(
    () => args.onSettled({ kind: "withdrawn" }),
    (err: unknown) => {
      if (err instanceof ApiError && err.status === 404) {
        args.onSettled({ kind: "gone" });
        return;
      }
      // The delete can land and only its answer be lost — a reset connection, a
      // proxy timeout. The queue is the truth, so ask it before saying
      // anything; un-mark first, so a list that still holds the row can show
      // the badge again.
      withdrawn.delete(row.id);
      void args.relist().then(
        (queue) => {
          if (queue.some((prompt) => prompt.id === row.id)) {
            args.onSettled({ kind: "stillQueued", queue });
            return;
          }
          // Gone, but not provably withdrawn: it may have been taken by the
          // round that was starting. Reported as such, so nothing refills.
          withdrawn.add(row.id);
          args.onSettled({ kind: "gone" });
        },
        () => args.onSettled({ kind: "unknown" }),
      );
    },
  );
}
