import { describe, expect, it } from "vitest";
import { formatElapsed, type Task } from "../api/client";
import { formatDuration } from "./duration";

describe("formatDuration", () => {
  it("formats a sub-second duration", () => {
    expect(formatDuration(0)).toBe("<1s");
    expect(formatDuration(999)).toBe("<1s");
  });

  it("formats seconds", () => {
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(59_999)).toBe("59s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(80_000)).toBe("1m 20s");
  });

  it("formats hours", () => {
    expect(formatDuration(3_900_000)).toBe("1h 5m");
    expect(formatDuration(2 * 3_600_000)).toBe("2h 0m");
  });
});

describe("formatElapsed", () => {
  it("keeps its existing output", () => {
    // The running-task card and the tray read this shape, including the `0s`
    // a task that started and finished in the same millisecond shows.
    const sameMillisecond = { started_at: 5_000, finished_at: 5_000 } as unknown as Task;
    expect(formatElapsed(sameMillisecond)).toBe("0s");

    const minuteAndChange = { started_at: 0, finished_at: 80_000 } as unknown as Task;
    expect(formatElapsed(minuteAndChange)).toBe("1m 20s");
  });
});
