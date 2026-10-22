import { afterEach, describe, expect, it, vi } from "vitest";
import { streamEvents, type WSMessage } from "./client";

/**
 * The channel policy, on its own.
 *
 * Which channel the console uses is decided here and nowhere else: a stream is
 * preferred, long-polling is the fallback, and the two failure modes that look
 * identical from the outside — "the Hub is unreachable" and "something between
 * us is buffering the Hub's responses" — have to be told apart. The first is
 * temporary and the stream must come back; the second is a property of the
 * network and retrying it forever just burns connections.
 */

function sseFrame(message: WSMessage): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`);
}

const deleted: WSMessage = { kind: "task_deleted", data: { id: "task-1" } };

/** A stream the test drives a chunk at a time. */
function liveStream(signal: AbortSignal | null | undefined) {
  let push!: (chunk: Uint8Array) => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk) => controller.enqueue(chunk);
      // A real fetch errors the body when the request is aborted; a hand-built
      // response has to do that itself or the watchdog would hang forever.
      signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
    },
  });
  return { res: { ok: true, status: 200, body } as unknown as Response, push };
}

/** A response the Hub accepts and then never writes a byte to. */
function silentStream(signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(new Error("aborted")));
    },
  });
  return { ok: true, status: 200, body } as unknown as Response;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("streamEvents", () => {
  it("keeps retrying while the Hub is unreachable", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(() => Promise.reject(new TypeError("offline")));
    vi.stubGlobal("fetch", fetchMock);
    const onUnavailable = vi.fn();

    const stop = streamEvents({ onMessage: vi.fn(), onUnavailable });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchMock.mock.calls.length).toBeGreaterThan(3);
    expect(onUnavailable).not.toHaveBeenCalled();
    stop();
  });

  it("picks the stream back up once the Hub is reachable again", async () => {
    vi.useFakeTimers();
    let failing = 2;
    const streams: ReturnType<typeof liveStream>[] = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (failing-- > 0) return Promise.reject(new TypeError("offline"));
      const stream = liveStream(init?.signal);
      streams.push(stream);
      return Promise.resolve(stream.res);
    });
    vi.stubGlobal("fetch", fetchMock);
    const onMessage = vi.fn();
    const onOpen = vi.fn();

    const stop = streamEvents({ onMessage, onOpen });
    // Long enough for both failures and the backoff between them; short of the
    // first-byte watchdog, which would abort the stream we are about to feed.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(streams).toHaveLength(1);

    streams[0].push(sseFrame(deleted));
    await vi.advanceTimersByTimeAsync(0);

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(deleted);
    stop();
  });

  it("gives up on a stream the Hub accepts and leaves silent", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      Promise.resolve(silentStream(init?.signal)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onUnavailable = vi.fn();
    const onStatus = vi.fn();

    const stop = streamEvents({ onMessage: vi.fn(), onUnavailable, onStatus });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(onUnavailable).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith("disconnected");

    // And it stays given up: long-polling is the caller's job from here.
    const attempts = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchMock.mock.calls.length).toBe(attempts);
    stop();
  });
});
