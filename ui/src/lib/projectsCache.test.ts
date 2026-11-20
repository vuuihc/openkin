import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../api/client";
import {
  cachedProjects,
  resetProjectsCache,
  setCachedProjects,
  subscribeProjects,
} from "./projectsCache";

/**
 * The kept block is a module store, so the page's three-state contract (first
 * load / kept rows / failed revalidation) stays readable at the page level. These
 * are the store's own promises: nothing before a read, one notification per
 * successful read, and a test hook that really forgets.
 */

const ALPHA: Project = {
  id: "p1",
  name: "alpha",
  mode: "ship",
  status: "active",
  created_at: 1,
  updated_at: 2,
  last_active_at: 3,
  roots: ["/work/alpha"],
};

beforeEach(() => {
  resetProjectsCache();
});

describe("the projects cache", () => {
  it("starts with nothing until a read succeeds", () => {
    expect(cachedProjects()).toBeNull();
  });

  it("keeps the successful read and returns the same rows", () => {
    setCachedProjects([ALPHA]);
    expect(cachedProjects()).toEqual([ALPHA]);
    // The exact array is the snapshot: `useSyncExternalStore` compares by
    // reference and a fresh copy on every read would loop.
    expect(cachedProjects()).toBe(cachedProjects());
  });

  it("notifies subscribers per successful read, not per failed one", () => {
    const notify = vi.fn();
    const stop = subscribeProjects(notify);

    // A failed revalidation never calls `setCachedProjects`, so there is no
    // failed-read notification to assert here — only the success path exists.
    setCachedProjects([ALPHA]);
    expect(notify).toHaveBeenCalledTimes(1);

    setCachedProjects([]);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(cachedProjects()).toEqual([]);

    stop();
    setCachedProjects([ALPHA]);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("forgets the block when the test hook runs", () => {
    setCachedProjects([ALPHA]);
    resetProjectsCache();
    expect(cachedProjects()).toBeNull();
  });
});
