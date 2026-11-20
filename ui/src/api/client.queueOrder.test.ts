import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, reorderQueuedPrompts, type QueuedPrompt } from "./client";

/**
 * Putting the queue in a new delivery order is one request that names the whole
 * queue, every id once. The answer is the whole queue as the daemon now has it,
 * not a delta: a delta applied to a queue that changed in between would compose
 * an order that never existed (ADR 0033).
 *
 * A 409 is not a failure to hide: it says the ids are not exactly the current
 * queue — a turn boundary delivered the head, or another device changed it — and
 * the caller's move is to re-read the queue, not to retry the same list.
 */

type Call = { method: string; url: string; body: unknown };

function stubFetch(status: number, payload: unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reorderQueuedPrompts", () => {
  it("PUTs the whole id list and returns the daemon's queue", async () => {
    // The daemon answers with its own order, which need not match what was
    // asked for: another device may have moved something in between, and this
    // is the copy the console shows.
    const queue: QueuedPrompt[] = [
      { id: 3, prompt: "third", user_seq: 3, queued_at: 1, position: 1 },
      { id: 1, prompt: "first", user_seq: 1, queued_at: 2, position: 2 },
    ];
    const calls = stubFetch(200, queue);

    await expect(reorderQueuedPrompts("task-1", [3, 1])).resolves.toEqual(queue);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe("/api/tasks/task-1/prompts/order");
    expect(calls[0].body).toEqual({ ids: [3, 1] });
  });

  it("surfaces 409 so the caller can refetch", async () => {
    stubFetch(409, { error: "not the current queue" });

    const err: unknown = await reorderQueuedPrompts("task-1", [3, 1]).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    // The status is the whole point: the caller tells "your list is stale, ask
    // again" from a real failure by this number and nothing else.
    expect((err as ApiError).status).toBe(409);
  });
});
