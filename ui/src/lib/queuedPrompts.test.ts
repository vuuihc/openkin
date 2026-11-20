import { describe, expect, it, vi } from "vitest";
import { ApiError, type QueuedPrompt } from "../api/client";
import {
  canRefillComposer,
  EDIT_IN_FLIGHT_MS,
  editStillRunning,
  isMessageQueued,
  moveQueuedId,
  queueOrderAfterMove,
  queuePositions,
  queuedMessageSeqs,
  startEdit,
  startWithdrawal,
  withoutWithdrawn,
} from "./queuedPrompts";

function prompt(userSeq: number, text = "waiting"): QueuedPrompt {
  return { id: userSeq, prompt: text, user_seq: userSeq, queued_at: 1 };
}

/** A queue row with an explicit id, so order and identity can disagree. */
function entry(id: number, position?: number): QueuedPrompt {
  return { id, prompt: `#${id}`, user_seq: id, queued_at: 1, ...(position === undefined ? {} : { position }) };
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

describe("canRefillComposer", () => {
  it("is true only when there is nothing in the composer to lose", () => {
    expect(canRefillComposer({ prompt: "", attachments: [] })).toBe(true);
    // Whitespace is not a draft worth protecting...
    expect(canRefillComposer({ prompt: "  \n ", attachments: [] })).toBe(true);
    // ...but typed words and an attached file both are.
    expect(canRefillComposer({ prompt: "half a thought", attachments: [] })).toBe(false);
    expect(canRefillComposer({ prompt: "", attachments: [{}] })).toBe(false);
  });
});

describe("editStillRunning", () => {
  it("holds the pencil only while a request is worth waiting for", () => {
    // No request: nothing to wait for.
    expect(editStillRunning(0, 1_000_000)).toBe(false);
    // Just started: a second tap would withdraw a second message the composer
    // cannot take yet.
    expect(editStillRunning(1_000_000, 1_000_500)).toBe(true);
    // Past the deadline the request is presumed lost — `apiFetch` has no
    // timeout, so a flag would lock the pencil for the life of the page.
    expect(editStillRunning(1_000_000, 1_000_000 + EDIT_IN_FLIGHT_MS)).toBe(false);
    expect(editStillRunning(1_000_000, 1_000_000 + EDIT_IN_FLIGHT_MS - 1)).toBe(true);
  });
});

describe("startEdit", () => {
  const row = prompt(7, "hold that thought");
  /** The promise chain runs a microtask after the call; let it. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("refills only when the daemon says it deleted the row", async () => {
    const withdrawn = new Set<number>();
    const onSettled = vi.fn();
    const request = vi.fn().mockResolvedValue(undefined);
    const relist = vi.fn();

    startEdit({ row, withdrawn, request, relist, onSettled });
    // Marked before the request goes out: the page drops the badge at once, and
    // a poll answered before the delete landed must not put it back.
    expect(withdrawn.has(row.id)).toBe(true);
    expect(onSettled).not.toHaveBeenCalled();
    await settle();

    expect(request).toHaveBeenCalledWith(row.id);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({ kind: "withdrawn" });
    // The queue was not in doubt, so it was not asked.
    expect(relist).not.toHaveBeenCalled();
  });

  it("does not refill on the 404 that may mean the message is already running", async () => {
    // The turn boundary and the delete race for the same row. If the boundary
    // won, the message is in the round — and a copy in the composer would be a
    // message sent twice.
    const withdrawn = new Set<number>();
    const onSettled = vi.fn();
    const relist = vi.fn();

    startEdit({
      row,
      withdrawn,
      request: vi.fn().mockRejectedValue(new ApiError(404, "not queued")),
      relist,
      onSettled,
    });
    await settle();

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({ kind: "gone" });
    expect(relist).not.toHaveBeenCalled();
    expect(withdrawn.has(row.id)).toBe(true);
  });

  it("puts the badge back when the row is still queued", async () => {
    // The delete failed for a reason other than "gone", and the queue says the
    // message is still waiting. The mark has to come off before the list is
    // applied, or the badge would stay hidden on a message that will run.
    const withdrawn = new Set<number>();
    const onSettled = vi.fn();
    let markedWhenAsked = true;

    startEdit({
      row,
      withdrawn,
      request: vi.fn().mockRejectedValue(new ApiError(500, "boom")),
      relist: vi.fn(async () => {
        markedWhenAsked = withdrawn.has(row.id);
        return [row, prompt(9)];
      }),
      onSettled,
    });
    await settle();

    expect(markedWhenAsked).toBe(false);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({ kind: "stillQueued", queue: [row, prompt(9)] });
  });

  it("reports a lost answer as gone, not as a withdrawal", async () => {
    // The delete can land and only its answer be lost. The row is gone from the
    // queue, but that does not prove the message was withdrawn rather than
    // taken by the round — so it is reported as the uncertain case and nothing
    // refills.
    const withdrawn = new Set<number>();
    const onSettled = vi.fn();

    startEdit({
      row,
      withdrawn,
      request: vi.fn().mockRejectedValue(new ApiError(502, "bad gateway")),
      relist: vi.fn(async () => [prompt(9)]),
      onSettled,
    });
    await settle();

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({ kind: "gone" });
    expect(withdrawn.has(row.id)).toBe(true);
  });

  it("says the outcome is unknown when the queue cannot be read either", async () => {
    const onSettled = vi.fn();

    startEdit({
      row,
      withdrawn: new Set<number>(),
      request: vi.fn().mockRejectedValue(new ApiError(500, "boom")),
      relist: vi.fn().mockRejectedValue(new ApiError(500, "nope")),
      onSettled,
    });
    await settle();

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith({ kind: "unknown" });
  });
});

describe("queuePositions", () => {
  it("numbers the daemon's order from one", () => {
    // The array arrives in the daemon's order (`position ASC, id ASC`). Here B
    // was queued first even though its id is larger, so sorting by id would
    // number the queue backwards.
    const received = [entry(9, 1), entry(4, 2)];

    const positions = queuePositions(received);

    expect(positions.get(9)).toBe(1);
    expect(positions.get(4)).toBe(2);
    expect(positions.size).toBe(2);
  });

  it("is empty for an empty queue", () => {
    expect(queuePositions([]).size).toBe(0);
  });
});

describe("moveQueuedId", () => {
  it("moves one id and returns every id exactly once", () => {
    const up = moveQueuedId([1, 2, 3], 3, -1);
    const down = moveQueuedId([1, 2, 3], 1, 1);

    expect(up).toEqual([1, 3, 2]);
    expect(down).toEqual([2, 1, 3]);
    // The endpoint wants the whole list, not a subset: a move that dropped an
    // id would answer 409.
    expect(up).toHaveLength(3);
    expect([...(up ?? [])].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("refuses to move past either end", () => {
    // Null, not an unchanged list: there is nothing to send, and the caller
    // draws the arrow disabled rather than firing a no-op request.
    expect(moveQueuedId([1, 2, 3], 1, -1)).toBeNull();
    expect(moveQueuedId([1, 2, 3], 3, 1)).toBeNull();
    expect(moveQueuedId([1, 2, 3], 99, -1)).toBeNull();
    expect(moveQueuedId([], 1, 1)).toBeNull();
  });

  it("leaves the array it was given alone", () => {
    const ids = [1, 2, 3];

    moveQueuedId(ids, 3, -1);

    expect(ids).toEqual([1, 2, 3]);
  });
});

describe("queueOrderAfterMove", () => {
  it("builds the order from the prompts as received", () => {
    // `position` is an ordering key, not an index, and the array is already in
    // the daemon's order. Sorting by `position` here would be a second opinion
    // about delivery order — the lie ADR 0033 forbids.
    const received = [entry(12, 5), entry(7, 2)];

    // 12 is first in the received array, so it can go down but not up.
    expect(queueOrderAfterMove(received, 12, 1)).toEqual([7, 12]);
    expect(queueOrderAfterMove(received, 12, -1)).toBeNull();
  });

  it("returns null for an id that is not queued", () => {
    expect(queueOrderAfterMove([entry(12)], 7, -1)).toBeNull();
  });
});
