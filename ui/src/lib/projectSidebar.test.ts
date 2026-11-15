import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  archiveProject,
  getArchivedProjects,
  getPinnedProjects,
  getProjectSortMode,
  setProjectSortMode,
  toggleProjectPinned,
  unarchiveProject,
} from "./projectSidebar";

/**
 * The preferences the list keeps across reloads.
 *
 * Grouping and ordering moved to `sessionBucketOrder.ts` when the phone list
 * and the sidebar became one component; what remains here is only the stored
 * state, so these tests are about what survives a reload, not about order.
 */

const store = new Map<string, string>();

vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
  clear: () => {
    store.clear();
  },
});

beforeEach(() => {
  store.clear();
});

describe("project sidebar persisted preferences", () => {
  it("persists the selected project sort mode", () => {
    expect(getProjectSortMode()).toBe("active");

    setProjectSortMode("created");

    expect(getProjectSortMode()).toBe("created");
  });

  it("clears a project pin when archiving the project", () => {
    expect(toggleProjectPinned("/alpha")).toBe(true);

    archiveProject("/alpha");

    expect(getArchivedProjects()).toEqual(["/alpha"]);
    expect(getPinnedProjects()).toEqual([]);
  });

  it("moves a project in and out of the archived list", () => {
    archiveProject("/alpha");
    expect(getArchivedProjects()).toEqual(["/alpha"]);

    unarchiveProject("/alpha");
    expect(getArchivedProjects()).toEqual([]);
  });
});
