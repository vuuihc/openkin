import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionScroll,
  getSessionScroll,
  setSessionScroll,
} from "./sessionScroll";

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

describe("sessionScroll", () => {
  it("stores and restores scrollTop per task", () => {
    expect(getSessionScroll("t1")).toBeNull();
    setSessionScroll("t1", 420);
    expect(getSessionScroll("t1")).toBe(420);
    setSessionScroll("t2", 12);
    expect(getSessionScroll("t1")).toBe(420);
    expect(getSessionScroll("t2")).toBe(12);
  });

  it("clears a single task", () => {
    setSessionScroll("t1", 100);
    clearSessionScroll("t1");
    expect(getSessionScroll("t1")).toBeNull();
  });

  it("ignores invalid values", () => {
    setSessionScroll("t1", -1);
    expect(getSessionScroll("t1")).toBeNull();
    setSessionScroll("", 10);
    expect(getSessionScroll("")).toBeNull();
  });
});
