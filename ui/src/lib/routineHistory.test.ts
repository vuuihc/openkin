import { describe, expect, it } from "vitest";
import type { Task } from "../api/client";
import {
  appendOlderRuns,
  foldRoutineRun,
  pageCursor,
  reconcileRoutineReads,
  ROUTINE_HISTORY_MAX,
} from "./routineHistory";

/**
 * The routine editor's run list is a snapshot plus what the daemon pushes.
 * These are the merges that keep it honest: a live update, an older page loaded
 * on demand, and a fetch reconciled against what the reader already marked read.
 *
 * Ids are zero-padded numerals so string order matches chronological order the
 * way a ULID's does — the fold places an unknown run by its id.
 */
function run(id: string, extra: Partial<Task> = {}): Task {
  return { id, status: "running", ...extra } as Task;
}

describe("foldRoutineRun", () => {
  it("replaces a known run in place", () => {
    const list = [run("003"), run("002"), run("001")];
    const next = foldRoutineRun(list, run("002", { status: "done" }))!;
    expect(next.map((x) => x.id)).toEqual(["003", "002", "001"]);
    expect(next[1].status).toBe("done");
    // The old array is untouched: React state compares by identity.
    expect(list[1].status).toBe("running");
  });

  it("puts a run that started after the fetch at the front", () => {
    // A scheduled run (or Run now) while the editor is open. Without this the
    // list would stay frozen until the editor was reopened.
    const next = foldRoutineRun([run("002"), run("001")], run("003"))!;
    expect(next.map((x) => x.id)).toEqual(["003", "002", "001"]);
  });

  it("puts an old run that just changed in its chronological place", () => {
    // Marking an old run read also arrives as a task update. Putting it at the
    // front would show a week-old run above this morning's and would survive
    // "load older" only as a misplaced row.
    const next = foldRoutineRun([run("004"), run("002"), run("001")], run("003"))!;
    expect(next.map((x) => x.id)).toEqual(["004", "003", "002", "001"]);
  });

  it("does not drop loaded older pages when a new run arrives", () => {
    // "Load older" grows the list past one page; prepending must not slice it
    // back to the first page.
    const list = Array.from({ length: 25 }, (_, i) => run(String(25 - i).padStart(3, "0")));
    const next = foldRoutineRun(list, run("026"))!;
    expect(next).toHaveLength(26);
    expect(next[next.length - 1].id).toBe("001");
  });

  it("bounds a list that keeps growing while the editor stays open", () => {
    // Live runs arrive forever and loaded pages only add; without a cap a busy
    // routine's editor would grow without one.
    const list = Array.from({ length: ROUTINE_HISTORY_MAX }, (_, i) =>
      run(String(ROUTINE_HISTORY_MAX - i).padStart(3, "0")),
    );
    const next = foldRoutineRun(list, run(String(ROUTINE_HISTORY_MAX + 1).padStart(3, "0")))!;
    expect(next).toHaveLength(ROUTINE_HISTORY_MAX);
    expect(next[0].id).toBe("201");
    // The oldest row is the one dropped.
    expect(next[next.length - 1].id).toBe("002");
  });

  it("leaves an unloaded routine alone", () => {
    // The editor fetches on open; a push for a routine that has no list must
    // not create a partial history the fetch would contradict.
    expect(foldRoutineRun(undefined, run("003"))).toBeUndefined();
  });

  it("keeps the list stable when the same update arrives twice", () => {
    // Run now folds the returned task, then the websocket pushes the same run.
    const once = foldRoutineRun([run("001")], run("002"))!;
    const twice = foldRoutineRun(once, run("002"))!;
    expect(twice.map((x) => x.id)).toEqual(["002", "001"]);
  });
});

describe("appendOlderRuns", () => {
  it("appends the page after the runs already loaded", () => {
    const next = appendOlderRuns([run("004"), run("003")], [run("002"), run("001")]);
    expect(next.map((x) => x.id)).toEqual(["004", "003", "002", "001"]);
  });

  it("keeps one copy of a run on both sides of the cursor", () => {
    // A run that started while the older page was in flight can be returned
    // twice; a duplicate would break the React key and show two rows.
    const next = appendOlderRuns([run("003"), run("002")], [run("002"), run("001")]);
    expect(next.map((x) => x.id)).toEqual(["003", "002", "001"]);
  });

  it("puts the page below a deeper run that a push already added", () => {
    // Marking a run older than the loaded window read arrives as a push and is
    // placed at the tail. The next page belongs above that row, not after it.
    const list = [run("025"), run("024"), run("005")];
    const next = appendOlderRuns(list, [run("023"), run("022"), run("021")]);
    expect(next.map((x) => x.id)).toEqual(["025", "024", "023", "022", "021", "005"]);
  });

  it("bounds the list on the paging path too", () => {
    // The cap is a property of the list, not of the fold that happened to add
    // the last row; a page merged into a full list must not exceed it.
    const list = Array.from({ length: ROUTINE_HISTORY_MAX }, (_, i) =>
      run(String(ROUTINE_HISTORY_MAX - i).padStart(3, "0")),
    );
    const next = appendOlderRuns(list, [run("000")]);
    expect(next).toHaveLength(ROUTINE_HISTORY_MAX);
    expect(next[next.length - 1].id).toBe("001");
  });
});

describe("reconcileRoutineReads", () => {
  it("clears every row after Mark all read", () => {
    // Mark-all publishes no task update, so a page fetched before it would
    // otherwise come back unread over a badge that says otherwise.
    const page = [run("002", { routine_unread: true }), run("001", { routine_unread: true })];
    const next = reconcileRoutineReads(page, true, new Set());
    expect(next.map((x) => x.routine_unread)).toEqual([false, false]);
  });

  it("clears only the rows the console saw marked", () => {
    const page = [
      run("003", { routine_unread: true }),
      run("002", { routine_unread: true }),
      run("001", { routine_unread: true }),
    ];
    const next = reconcileRoutineReads(page, false, new Set(["002"]));
    expect(next.map((x) => x.routine_unread)).toEqual([true, false, true]);
  });

  it("leaves the fetched rows untouched when nothing was marked", () => {
    const page = [run("001", { routine_unread: true })];
    expect(reconcileRoutineReads(page, false, new Set())[0]).toBe(page[0]);
  });
});

describe("pageCursor", () => {
  it("is the oldest id the page returned", () => {
    expect(pageCursor([run("003"), run("002"), run("001")])).toBe("001");
  });

  it("is empty when the page was empty", () => {
    // An empty cursor is the daemon's "no filter"; asking with it would return
    // the newest page again and append nothing.
    expect(pageCursor([])).toBe("");
  });

  it("does not follow a deeper run that a push added after the page", () => {
    // The loaded list can hold a run far below the fetched boundary (a mark-read
    // push for an old run). Using the list's tail as the cursor would ask below
    // that run and skip everything between it and the boundary.
    const page = [run("025"), run("024"), run("016")];
    const list = foldRoutineRun(page, run("005"))!;
    expect(list[list.length - 1].id).toBe("005");
    expect(pageCursor(page)).toBe("016");
    // And the page below the boundary lands above the deep row.
    const next = appendOlderRuns(list, [run("015"), run("014")]);
    expect(next.map((x) => x.id)).toEqual(["025", "024", "016", "015", "014", "005"]);
  });
});
