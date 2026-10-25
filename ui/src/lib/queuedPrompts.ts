import type { QueuedPrompt } from "../api/client";

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
