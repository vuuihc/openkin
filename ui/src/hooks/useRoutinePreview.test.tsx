// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRoutinePreview } from "./useRoutinePreview";

/**
 * The next-run line under a routine's schedule. What is pinned here is the
 * contract the form depends on: the daemon is asked once the edit settles, an
 * answer for a rule the form has already left is dropped, and a form with
 * nothing to preview keeps the line empty.
 */
type Preview = { next_due_at: number };

function deferred() {
  let resolve!: (v: Preview) => void;
  const promise = new Promise<Preview>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("useRoutinePreview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks once the edit settles, not on every keystroke", async () => {
    const fetchPreview = vi.fn().mockResolvedValue({ next_due_at: 111 });
    const { result, rerender } = renderHook(
      ({ payload }: { payload: string }) => useRoutinePreview(payload, fetchPreview, 250),
      { initialProps: { payload: "a" } },
    );
    expect(fetchPreview).not.toHaveBeenCalled();

    rerender({ payload: "b" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(249);
    });
    expect(fetchPreview).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchPreview).toHaveBeenCalledTimes(1);
    expect(fetchPreview).toHaveBeenCalledWith("b");
    expect(result.current).toBe(111);
  });

  it("drops an answer for a rule the form has already left", async () => {
    const first = deferred();
    const fetchPreview = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ next_due_at: 222 });
    const { result, rerender } = renderHook(
      ({ payload }: { payload: string }) => useRoutinePreview(payload, fetchPreview, 0),
      { initialProps: { payload: "old" } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchPreview).toHaveBeenCalledWith("old");

    rerender({ payload: "new" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(222);

    // The old request resolves last. Showing it would put a time on screen
    // that belongs to a rule the reader has already changed.
    await act(async () => {
      first.resolve({ next_due_at: 111 });
      await Promise.resolve();
    });
    expect(result.current).toBe(222);
  });

  it("clears the old rule's time while the new one is being answered", async () => {
    // The debounce and the round trip take time. Keeping the previous answer
    // on screen through them would show "next run" for a rule the reader has
    // already changed — the exact promise this line must not make.
    const second = deferred();
    const fetchPreview = vi
      .fn()
      .mockResolvedValueOnce({ next_due_at: 111 })
      .mockImplementationOnce(() => second.promise);
    const { result, rerender } = renderHook(
      ({ payload }: { payload: string }) => useRoutinePreview(payload, fetchPreview, 0),
      { initialProps: { payload: "old" } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(111);

    rerender({ payload: "new" });
    expect(result.current).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Still null while the new answer is outstanding.
    expect(result.current).toBeNull();

    await act(async () => {
      second.resolve({ next_due_at: 222 });
      await Promise.resolve();
    });
    expect(result.current).toBe(222);
  });

  it("clears the line when there is nothing to preview", async () => {
    const fetchPreview = vi.fn().mockResolvedValue({ next_due_at: 111 });
    const { result, rerender } = renderHook(
      ({ payload }: { payload: string }) => useRoutinePreview(payload, fetchPreview, 0),
      { initialProps: { payload: "rule" } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBe(111);

    rerender({ payload: "" });
    await act(async () => {});
    expect(result.current).toBeNull();
    expect(fetchPreview).toHaveBeenCalledTimes(1);
  });

  it("says nothing when the request fails", async () => {
    const fetchPreview = vi.fn().mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useRoutinePreview("rule", fetchPreview, 0));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current).toBeNull();
  });
});
