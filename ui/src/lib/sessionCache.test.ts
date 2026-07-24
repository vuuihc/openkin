import { describe, expect, it } from "vitest";
import {
  dropSessionCache,
  taskIdFromPathname,
  touchSessionCache,
} from "./sessionCache";

describe("touchSessionCache", () => {
  it("promotes existing id to front", () => {
    expect(touchSessionCache(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
  });

  it("inserts new id at front and caps size", () => {
    const prev = ["1", "2", "3", "4", "5", "6", "7", "8"];
    expect(touchSessionCache(prev, "9", 8)).toEqual([
      "9",
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
    ]);
  });

  it("ignores empty id", () => {
    expect(touchSessionCache(["a"], "")).toEqual(["a"]);
  });
});

describe("dropSessionCache", () => {
  it("removes id", () => {
    expect(dropSessionCache(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("taskIdFromPathname", () => {
  it("parses task routes only", () => {
    expect(taskIdFromPathname("/tasks/abc")).toBe("abc");
    expect(taskIdFromPathname("/tasks/abc/")).toBe("abc");
    expect(taskIdFromPathname("/tasks")).toBeNull();
    expect(taskIdFromPathname("/new")).toBeNull();
    expect(taskIdFromPathname("/tasks/a%2Fb")).toBe("a/b");
  });
});
