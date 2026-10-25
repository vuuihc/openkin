import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SESSION_TABS,
  closeSessionTab,
  moveSessionTab,
  neighbourTab,
  openSessionTab,
  readSessionTabs,
  writeSessionTabs,
} from "./sessionTabs";

const store = new Map<string, string>();

const localStorageMock = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
  clear: () => {
    store.clear();
  },
};

vi.stubGlobal("localStorage", localStorageMock);

afterEach(() => {
  store.clear();
});

describe("openSessionTab", () => {
  // Identity, not just equality: the caller writes to storage only when the
  // array it got back is a different one, so "already open" has to be free.
  it("appends a new tab and leaves an open one alone", () => {
    const order = ["a", "b"];
    expect(openSessionTab(order, "c")).toEqual(["a", "b", "c"]);
    expect(openSessionTab(order, "b")).toBe(order);
    expect(openSessionTab(order, "")).toBe(order);
  });

  // The just-opened tab is the rightmost, so the cap can only ever drop
  // something the user is not looking at.
  it("drops from the left once the strip is full", () => {
    const full = Array.from({ length: MAX_SESSION_TABS }, (_, i) => `t${i}`);
    const next = openSessionTab(full, "new");
    expect(next).toHaveLength(MAX_SESSION_TABS);
    expect(next[0]).toBe("t1");
    expect(next[next.length - 1]).toBe("new");
  });
});

describe("closeSessionTab", () => {
  it("removes a tab, and says so by identity when there was nothing to remove", () => {
    expect(closeSessionTab(["a", "b"], "a")).toEqual(["b"]);
    const order = ["a"];
    expect(closeSessionTab(order, "z")).toBe(order);
    expect(closeSessionTab(order, "")).toBe(order);
  });
});

describe("moveSessionTab", () => {
  it("swaps with the neighbour in both directions", () => {
    expect(moveSessionTab(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
    expect(moveSessionTab(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveSessionTab(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
    expect(moveSessionTab(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
  });

  // The same rule the terminal strip's roving focus uses for its arrows.
  it("wraps at both ends", () => {
    expect(moveSessionTab(["a", "b", "c"], "c", 1)).toEqual(["c", "a", "b"]);
    expect(moveSessionTab(["a", "b", "c"], "a", -1)).toEqual(["b", "c", "a"]);
  });

  it("is a no-op for a single tab, an unknown id, or no movement", () => {
    const one = ["a"];
    expect(moveSessionTab(one, "a", 1)).toBe(one);
    const three = ["a", "b", "c"];
    expect(moveSessionTab(three, "z", 1)).toBe(three);
    expect(moveSessionTab(three, "b", 0)).toBe(three);
  });

  it("never loses or duplicates a tab", () => {
    let order = ["a", "b", "c", "d"];
    for (const delta of [1, 1, -1, 1, 1, 1]) {
      order = moveSessionTab(order, "b", delta);
      expect([...order].sort()).toEqual(["a", "b", "c", "d"]);
    }
  });
});

describe("neighbourTab", () => {
  it("is the tab to the right, or to the left when it was last", () => {
    expect(neighbourTab(["a", "b", "c"], "a")).toBe("b");
    expect(neighbourTab(["a", "b", "c"], "c")).toBe("b");
  });

  it("is null when nothing is left, and the first tab for an unknown id", () => {
    expect(neighbourTab(["a"], "a")).toBeNull();
    expect(neighbourTab([], "a")).toBeNull();
    expect(neighbourTab(["a", "b"], "z")).toBe("a");
  });
});

describe("readSessionTabs / writeSessionTabs", () => {
  it("round-trips the order", () => {
    writeSessionTabs(["a", "b"]);
    expect(readSessionTabs()).toEqual(["a", "b"]);
  });

  // Storage is the one input here that a user, an older build, or a half-written
  // value can produce, so it is cleaned rather than trusted: a duplicate would be
  // a tab that cannot be closed (the close removes both, the strip redraws one).
  it("drops what is not an id, and what is there twice", () => {
    for (const raw of ["not json", '"a string"', "{}", "null"]) {
      store.set("kin.sessionTabs.v1", raw);
      expect(readSessionTabs()).toEqual([]);
    }
    store.set("kin.sessionTabs.v1", JSON.stringify(["a", "", "a", 7, null, "b"]));
    expect(readSessionTabs()).toEqual(["a", "b"]);
  });

  it("applies the cap to what it reads", () => {
    store.set(
      "kin.sessionTabs.v1",
      JSON.stringify(Array.from({ length: MAX_SESSION_TABS + 4 }, (_, i) => `t${i}`)),
    );
    const order = readSessionTabs();
    expect(order).toHaveLength(MAX_SESSION_TABS);
    expect(order[0]).toBe("t4");
  });

  it("is empty when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readSessionTabs()).toEqual([]);
    expect(() => writeSessionTabs(["a"])).not.toThrow();
    vi.stubGlobal("localStorage", localStorageMock);
  });
});
