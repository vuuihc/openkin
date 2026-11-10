// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskEvent } from "../api/client";
import { getMachineTask, listMachineTaskEvents } from "../api/client";
import { useRemoteTaskRun } from "./useRemoteTaskRun";

vi.mock("../api/client", () => ({
  getMachineTask: vi.fn(),
  listMachineTaskEvents: vi.fn(),
  isTerminal: (status: string) =>
    status === "succeeded" || status === "failed" || status === "canceled",
}));

const mockedTask = vi.mocked(getMachineTask);
const mockedEvents = vi.mocked(listMachineTaskEvents);

function task(status: string, id = "t-1"): Task {
  return { id, status, title: "Morning review" } as Task;
}

function events(...seqs: number[]): TaskEvent[] {
  return seqs.map((seq) => ({ seq, type: "message", payload: {} }) as TaskEvent);
}

describe("useRemoteTaskRun", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedTask.mockReset();
    mockedEvents.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks the machine, then polls a running run for what changed", async () => {
    mockedTask.mockResolvedValueOnce(task("running")).mockResolvedValueOnce(task("succeeded"));
    mockedEvents.mockResolvedValueOnce(events(1, 2)).mockResolvedValueOnce(events(3));

    const { result } = renderHook(() => useRemoteTaskRun("node-1", "t-1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mockedTask).toHaveBeenCalledWith("node-1", "t-1");
    expect(result.current.task?.status).toBe("running");
    expect(result.current.events.map((e) => e.seq)).toEqual([1, 2]);

    // The second read continues from the highest *contiguous* seq, so the
    // transcript is not fetched from the beginning again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(mockedEvents).toHaveBeenLastCalledWith("node-1", "t-1", 2);
    expect(result.current.task?.status).toBe("succeeded");
    expect(result.current.events.map((e) => e.seq)).toEqual([1, 2, 3]);

    // A finished run is not polled again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockedTask).toHaveBeenCalledTimes(2);
  });

  it("keeps the run on screen when a later poll fails, and retries", async () => {
    mockedTask
      .mockResolvedValueOnce(task("running"))
      .mockResolvedValueOnce(task("succeeded"))
      .mockResolvedValueOnce(task("succeeded"));
    mockedEvents
      .mockResolvedValueOnce(events(1))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(events(2));

    const { result } = renderHook(() => useRemoteTaskRun("node-1", "t-1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.loaded).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.error).toBeInstanceOf(Error);
    // The good answer is still there; a failed poll does not blank the page.
    expect(result.current.task?.status).toBe("running");
    expect(result.current.events.map((e) => e.seq)).toEqual([1]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.task?.status).toBe("succeeded");
    expect(result.current.error).toBeNull();
  });

  it("does not ask anyone without a machine and an id", async () => {
    renderHook(() => useRemoteTaskRun("", "t-1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mockedTask).not.toHaveBeenCalled();
    expect(mockedEvents).not.toHaveBeenCalled();
  });
});
