import { describe, expect, it } from "vitest";
import type { Project, ProjectPulse, Routine } from "../api/client";
import {
  clearProjectCover,
  readProjectCover,
  writeProjectCover,
  type ProjectCoverCache,
} from "./projectCoverCache";

/** A `sessionStorage` stand-in that keeps its values in a map. */
function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const project: Project = {
  id: "p1",
  name: "alpha",
  mode: "ship",
  status: "active",
  created_at: 1,
  updated_at: 2,
  last_active_at: 3,
  roots: ["/work/alpha"],
};

const pulse: ProjectPulse = {
  project_id: "p1",
  generated_at: 20,
  window_days: 14,
  session_total: 1,
  session_window: 1,
  sessions_running: 0,
  sessions_waiting: 0,
  session_heat: [{ date: "2026-11-10", count: 1 }],
  git_available: true,
  commit_window: 0,
  commit_heat: [],
  auto_markdown: "",
};

const routine = {
  id: "r1",
  prompt: "tidy",
  interval_secs: 86400,
  enabled: true,
  next_due_at: 30,
} as Routine;

const cover: ProjectCoverCache = {
  project,
  pulse,
  routines: [routine],
  routinesLoaded: true,
  latest: { key: "t1", at: 9, title: "newest", agentId: "kin", remote: false },
  lastImportAt: 8,
  activityLoaded: true,
  savedAt: 40,
};

describe("the project cover cache (KIN-PROJECT-001)", () => {
  it("round-trips the last cover for one project", () => {
    const storage = memoryStore();
    writeProjectCover("p1", cover, storage);

    expect(readProjectCover("p1", storage)).toEqual(cover);
    // A different project must not read another project's cover.
    expect(readProjectCover("p2", storage)).toBeNull();
  });

  it("drops a payload that names a different project", () => {
    const storage = memoryStore({
      "kin_project_cover:p1": JSON.stringify({ ...cover, project: { ...project, id: "p2" } }),
    });
    expect(readProjectCover("p1", storage)).toBeNull();
  });

  it("treats corrupt or half-written storage as a miss", () => {
    const storage = memoryStore({ "kin_project_cover:p1": "{not json" });
    expect(readProjectCover("p1", storage)).toBeNull();

    const blank = memoryStore({ "kin_project_cover:p1": JSON.stringify({ project: null }) });
    expect(readProjectCover("p1", blank)).toBeNull();
  });

  it("survives a storage that throws on every access", () => {
    const hostile = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(() => writeProjectCover("p1", cover, hostile)).not.toThrow();
    expect(readProjectCover("p1", hostile)).toBeNull();
    expect(() => clearProjectCover("p1", hostile)).not.toThrow();
  });

  it("forgets a project that no longer exists", () => {
    const storage = memoryStore();
    writeProjectCover("p1", cover, storage);
    clearProjectCover("p1", storage);
    expect(readProjectCover("p1", storage)).toBeNull();
  });
});
