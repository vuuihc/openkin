// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLocalTaskTitles, setLocalTaskTitle, subscribeTaskTitles } from "./taskTitles";

/**
 * KIN-MANAGE-001, step 5: a renamed conversation keeps its name in this
 * browser. The sibling is `taskPins.test.ts`: same storage, same tolerance for
 * corrupt or absent records, and a write that must never break the list.
 */
describe("taskTitles", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("stores a trimmed title and reads it back", () => {
    expect(setLocalTaskTitle("t1", "  Ship the build  ")).toEqual({ t1: "Ship the build" });
    expect(getLocalTaskTitles()).toEqual({ t1: "Ship the build" });

    // A second rename replaces the first; the map holds one title per task.
    setLocalTaskTitle("t1", "Ship it");
    setLocalTaskTitle("t2", "Fix the flaky test");
    expect(getLocalTaskTitles()).toEqual({ t1: "Ship it", t2: "Fix the flaky test" });
  });

  it("an empty or whitespace title removes the override", () => {
    setLocalTaskTitle("t1", "Ship it");
    expect(setLocalTaskTitle("t1", "   ")).toEqual({});
    expect(getLocalTaskTitles()).toEqual({});

    // An entry that never existed is simply not created.
    expect(setLocalTaskTitle("t2", "")).toEqual({});
    expect(getLocalTaskTitles()).toEqual({});
  });

  it("malformed storage reads as no overrides", () => {
    localStorage.setItem("kin_task_titles", "not json");
    expect(getLocalTaskTitles()).toEqual({});
    localStorage.setItem("kin_task_titles", JSON.stringify(["t1"]));
    expect(getLocalTaskTitles()).toEqual({});
    localStorage.setItem("kin_task_titles", JSON.stringify({ t1: 42, t2: "Kept" }));
    expect(getLocalTaskTitles()).toEqual({ t2: "Kept" });
  });

  it("a write notifies every mounted reader until it leaves", () => {
    const seen = vi.fn();
    const leave = subscribeTaskTitles(seen);
    setLocalTaskTitle("t1", "Ship it");
    expect(seen).toHaveBeenCalledTimes(1);
    // The map the notification is about is already readable.
    expect(getLocalTaskTitles()).toEqual({ t1: "Ship it" });

    // A surface that went away must not be called again.
    leave();
    setLocalTaskTitle("t2", "Ship that");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("another tab's write notifies this tab; an unrelated key does not", () => {
    const seen = vi.fn();
    const leave = subscribeTaskTitles(seen);
    try {
      window.dispatchEvent(new StorageEvent("storage", { key: "kin_task_titles" }));
      expect(seen).toHaveBeenCalledTimes(1);
      window.dispatchEvent(new StorageEvent("storage", { key: "kin_something_else" }));
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      leave();
    }
  });

  it("a refused write still returns the new map", () => {
    const refuse = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    try {
      // The in-memory answer is what the caller renders; a browser that
      // refuses storage must not make the rename look like it failed.
      expect(setLocalTaskTitle("t1", "Ship it")).toEqual({ t1: "Ship it" });
      expect(getLocalTaskTitles()).toEqual({});
    } finally {
      refuse.mockRestore();
    }
  });
});
