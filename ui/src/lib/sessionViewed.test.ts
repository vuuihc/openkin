import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getViewedSessionIds,
  isSessionViewed,
  clearSessionViewed,
  markSessionViewed,
  sessionStatusDotClass,
} from "./sessionViewed";

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

describe("sessionStatusDotClass", () => {
  it("blue pulse while running / queued / waiting", () => {
    expect(sessionStatusDotClass("running", false)).toBe("bg-kin-blue animate-pulse");
    expect(sessionStatusDotClass("queued", false)).toBe("bg-kin-blue animate-pulse");
    expect(sessionStatusDotClass("waiting_approval", false)).toBe(
      "bg-kin-blue animate-pulse",
    );
  });

  it("green when succeeded and not yet viewed", () => {
    expect(sessionStatusDotClass("succeeded", false)).toBe("bg-kin-green");
  });

  it("clears when succeeded and viewed", () => {
    expect(sessionStatusDotClass("succeeded", true)).toBeNull();
  });

  it("red on failed; none on canceled", () => {
    expect(sessionStatusDotClass("failed", false)).toBe("bg-kin-red");
    expect(sessionStatusDotClass("failed", true)).toBe("bg-kin-red");
    expect(sessionStatusDotClass("canceled", false)).toBeNull();
  });
});

describe("markSessionViewed / isSessionViewed", () => {
  it("marks a session viewed once", () => {
    expect(isSessionViewed("t1")).toBe(false);
    markSessionViewed("t1", 1000);
    expect(isSessionViewed("t1")).toBe(true);
    expect(getViewedSessionIds()).toEqual(["t1"]);
    // second mark is a no-op (does not throw / change id list)
    markSessionViewed("t1", 2000);
    expect(getViewedSessionIds()).toEqual(["t1"]);
  });
});

describe("clearSessionViewed", () => {
  it("removes viewed so the green dot can return", () => {
    markSessionViewed("t1", 1000);
    expect(isSessionViewed("t1")).toBe(true);
    clearSessionViewed("t1");
    expect(isSessionViewed("t1")).toBe(false);
    expect(getViewedSessionIds()).toEqual([]);
    // no-op when already clear
    clearSessionViewed("t1");
    expect(isSessionViewed("t1")).toBe(false);
  });
});
