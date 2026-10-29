import { describe, expect, it, vi } from "vitest";
import { ApiError, type QueuedPrompt } from "../api/client";
import {
  isMessageQueued,
  queuedMessageSeqs,
  startWithdrawal,
  withoutWithdrawn,
} from "./queuedPrompts";

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

describe("withoutWithdrawn", () => {
  it("drops a row the page has already taken back", () => {
    // A poll answered before the delete landed arrives after it; without this the
    // row — and the badge under the tap that removed it — comes back.
    const queue = [prompt(7), prompt(9)];

    expect(withoutWithdrawn(queue, new Set([7])).map((p) => p.id)).toEqual([9]);
  });

  it("leaves the queue alone when nothing was withdrawn", () => {
    const queue = [prompt(7)];

    // The same array, so the memo downstream does not churn on every poll.
    expect(withoutWithdrawn(queue, new Set())).toBe(queue);
  });

  it("matches on the row id, not the seq the transcript marks", () => {
    // The two are different numbers in production (one counts rows ever
    // queued, the other counts events), and filtering by the wrong one would
    // drop a message the user is still waiting on.
    const queue = [{ id: 41, prompt: "a", user_seq: 7, queued_at: 1 }];

    expect(withoutWithdrawn(queue, new Set([7]))).toEqual(queue);
    expect(withoutWithdrawn(queue, new Set([41]))).toEqual([]);
  });
});

describe("startWithdrawal", () => {
  const queue = [prompt(7), prompt(9)];
  /** The request's catch runs a microtask after the call; let it. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("takes the row out at once and asks the daemon to withdraw it", () => {
    const withdrawn = new Set<number>();
    const request = vi.fn().mockResolvedValue(undefined);

    const row = startWithdrawal({ queue, seq: 9, withdrawn, request, onError: vi.fn() });

    expect(row).toMatchObject({ id: 9 });
    expect(request).toHaveBeenCalledWith(9);
    // The mark outlives the request: it is what stops a poll that was answered
    // before the delete landed from putting the badge back.
    expect([...withdrawn]).toEqual([9]);
  });

  it("does nothing for a message that is not queued", () => {
    const request = vi.fn();

    const row = startWithdrawal({
      queue,
      seq: 8,
      withdrawn: new Set(),
      request,
      onError: vi.fn(),
    });

    expect(row).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });

  it("says nothing when the row was already gone", async () => {
    // It ran, or another device withdrew it. The message is not queued either
    // way, so an error toast here would be reporting a success as a failure.
    const withdrawn = new Set<number>();
    const onError = vi.fn();
    const request = vi.fn().mockRejectedValue(new ApiError(404, "not queued"));

    startWithdrawal({ queue, seq: 7, withdrawn, request, onError });
    await settle();

    expect(onError).not.toHaveBeenCalled();
    expect(withdrawn.has(7)).toBe(true);
  });

  it("un-marks the row when the withdrawal really failed", async () => {
    // The message is still queued, so the next poll has to be allowed to bring
    // the badge back. An id left marked would hide it for the life of the page,
    // and the message would look delivered.
    const withdrawn = new Set<number>();
    const onError = vi.fn();
    const request = vi.fn().mockRejectedValue(new ApiError(500, "boom"));

    startWithdrawal({ queue, seq: 7, withdrawn, request, onError });
    await settle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(withdrawn.has(7)).toBe(false);
  });
});
