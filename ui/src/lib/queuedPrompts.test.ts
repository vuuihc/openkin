import { describe, expect, it } from "vitest";
import type { QueuedPrompt } from "../api/client";
import { isMessageQueued, queuedMessageSeqs } from "./queuedPrompts";

function prompt(userSeq: number, text = "waiting"): QueuedPrompt {
  return { id: userSeq, prompt: text, user_seq: userSeq, queued_at: 1 };
}

describe("queuedMessageSeqs", () => {
  it("collects the seqs of the messages that are waiting", () => {
    const waiting = queuedMessageSeqs([prompt(7), prompt(9)]);

    expect([...waiting].sort((a, b) => a - b)).toEqual([7, 9]);
    expect(isMessageQueued(7, waiting)).toBe(true);
    expect(isMessageQueued(8, waiting)).toBe(false);
  });

  it("marks nothing for a prompt whose event write failed", () => {
    // user_seq 0 means there is no message in the transcript to mark: the write
    // that would have put one there failed when the prompt was accepted, and the
    // delivery writes it. Marking seq 0 instead would mark nothing, or worse,
    // whatever the transcript happens to have at 0.
    const waiting = queuedMessageSeqs([prompt(0)]);

    expect(waiting.size).toBe(0);
    expect(isMessageQueued(0, waiting)).toBe(false);
  });

  it("has nothing waiting for an empty queue", () => {
    const waiting = queuedMessageSeqs([]);

    expect(waiting.size).toBe(0);
    // A message with no seq at all (a streamed preview) is never queued: only a
    // message the daemon accepted has a seq, and only those can be waiting.
    expect(isMessageQueued(undefined, waiting)).toBe(false);
  });
});
