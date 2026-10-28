// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { getPinnedTaskIds, setTaskPinned } from "./taskPins";

describe("taskPins", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts empty", () => {
    expect(getPinnedTaskIds()).toEqual([]);
  });

  it("pins and unpins a task", () => {
    expect(setTaskPinned("t1", true)).toEqual(["t1"]);
    expect(getPinnedTaskIds()).toEqual(["t1"]);
    expect(setTaskPinned("t1", false)).toEqual([]);
  });

  it("appends new pins in pin order", () => {
    setTaskPinned("t1", true);
    setTaskPinned("t2", true);
    expect(getPinnedTaskIds()).toEqual(["t1", "t2"]);
    // Pinning twice is a no-op.
    setTaskPinned("t1", true);
    expect(getPinnedTaskIds()).toEqual(["t1", "t2"]);
  });

  it("ignores corrupt storage", () => {
    localStorage.setItem("kin_pinned_tasks", "not json");
    expect(getPinnedTaskIds()).toEqual([]);
    localStorage.setItem("kin_pinned_tasks", JSON.stringify({ id: "x" }));
    expect(getPinnedTaskIds()).toEqual([]);
  });
});
