import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The routine editor's run list must not be a snapshot that freezes when it
 * opens: a scheduled run or Run now has to land there, and ten rows cannot be
 * the whole story of a routine that has run for weeks.
 *
 * `routineHistory.test.ts` holds the two merges (fold a live update, append an
 * older page). What is left is the page wiring: the websocket handler and Run
 * now feed the fold, both fetches record the boundary they returned, the older
 * page asks below it, and the button only exists when there is something to ask
 * for.
 *
 * Source rather than DOM: mounting this page needs a daemon, a websocket, an
 * agent list and a router.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const PAGE = readFileSync(join(UI, "src/pages/RoutinesPage.tsx"), "utf8");

describe("the routine editor's run history", () => {
  it("folds live task updates into the open routine's list", () => {
    // Same websocket message that feeds the global run feed. Without the
    // second fold the editor's list stays where the fetch left it.
    expect(PAGE).toContain("const folded = foldRoutineRun(prev[t.routine_id!], t);");
    expect(PAGE).toContain("return folded ? { ...prev, [t.routine_id!]: folded } : prev;");
  });

  it("shows a Run now in the editor without waiting for the echo", () => {
    expect(PAGE).toContain("const folded = foldRoutineRun(prev[r.id], t);");
    expect(PAGE).toContain("return folded ? { ...prev, [r.id]: folded } : prev;");
  });

  it("asks for one page and records whether more may exist", () => {
    expect(PAGE).toContain(
      "const tasks = await listTasks({ routineId: id, limit: ROUTINE_HISTORY_PAGE });",
    );
    expect(PAGE).toContain("tasks.length >= ROUTINE_HISTORY_PAGE");
  });

  it("pages older runs from the boundary the last page returned", () => {
    // `before` is the daemon's ULID cursor. It must come from the page, not
    // from the list's tail: a live push can place a deeper run at the tail, and
    // asking below that id would skip every run between the two.
    expect(PAGE).toContain('const cursor = historyCursor[id] ?? "";');
    expect(PAGE).toContain("before: cursor,");
    expect(PAGE).toContain("setHistoryCursor((prev) => ({ ...prev, [id]: pageCursor(tasks) }));");
    expect(PAGE).toContain("setHistoryCursor((prev) => ({ ...prev, [id]: pageCursor(page) }));");
    expect(PAGE).toContain(
      "appendOlderRuns(prev[id] ?? [], reconcileRoutineReads(page, allRead, read))",
    );
    expect(PAGE).toContain("page.length >= ROUTINE_HISTORY_PAGE");
  });

  it("applies the newer page only after the newer-wins guard", () => {
    // The guard exists to drop a page the next open has outdated. Moving it
    // above the await would make it always pass, and a stale page would be
    // appended to the list the re-open replaced. Every write from that page —
    // rows, has-more, cursor — has to sit behind it.
    const start = PAGE.indexOf("const loadOlderHistory");
    const awaited = PAGE.indexOf("await listTasks", start);
    const guarded = PAGE.indexOf(
      "if (historySeq.current[id] !== seq || !isCurrentView(view)) return;",
      start,
    );
    const applied = PAGE.indexOf("appendOlderRuns(prev[id] ?? []", start);
    const hasMore = PAGE.indexOf(
      "setHistoryHasMore((prev) => ({ ...prev, [id]: page.length >= ROUTINE_HISTORY_PAGE }));",
      start,
    );
    const cursor = PAGE.indexOf(
      "setHistoryCursor((prev) => ({ ...prev, [id]: pageCursor(page) }));",
      start,
    );
    expect(awaited).toBeGreaterThan(start);
    expect(guarded).toBeGreaterThan(awaited);
    expect(applied).toBeGreaterThan(guarded);
    expect(hasMore).toBeGreaterThan(guarded);
    expect(cursor).toBeGreaterThan(guarded);
  });

  it("reconciles both fetches against what the reader already marked read", () => {
    // Mark all read publishes no task update, so a page that was already in
    // flight would otherwise append unread rows over a read badge.
    expect(PAGE).toContain("reconcileRoutineReads(tasks, allRead, read)");
    expect(PAGE).toContain("reconcileRoutineReads(page, allRead, read)");
    expect(PAGE).toContain("const epoch = readAllEpoch.current;");
    expect(PAGE).toContain("readAllEpoch.current += 1;");
  });

  it("discards an older page that a re-open has made stale", () => {
    // The cursor belongs to the list the re-open replaced; appending would skip
    // the rows between the two pages and could hide the button with a short
    // page. Every fetch path has the newest-wins guard.
    expect(PAGE).toContain("const seq = historySeq.current[id] ?? 0;");
    expect(
      PAGE.split("if (historySeq.current[id] !== seq || !isCurrentView(view)) return;")
        .length - 1,
    ).toBe(3);
  });

  it("keeps the history branches in loading / error / empty order", () => {
    // A failed fetch must not read as "this routine has never run", and a
    // loading state must not flash the empty line underneath it.
    const loading = PAGE.indexOf("historyLoading[editing.id] ?");
    const failure = PAGE.indexOf("historyError[editing.id] ?");
    const empty = PAGE.indexOf("(history[editing.id]?.length ?? 0) === 0 ?");
    expect(loading).toBeGreaterThan(-1);
    expect(failure).toBeGreaterThan(loading);
    expect(empty).toBeGreaterThan(failure);
  });

  it("loads the history when the editor opens", () => {
    expect(PAGE).toContain("void loadHistory(r.id);");
  });

  it("offers the older page only when the last one was full and the cap is not reached", () => {
    expect(PAGE).toContain("{historyHasMore[editing.id] &&");
    expect(PAGE).toContain("(history[editing.id]?.length ?? 0) < ROUTINE_HISTORY_MAX && (");
    // And the fetch refuses too: a long-lived editor whose list fills between
    // the render and the click must not ask for rows the merge would drop.
    expect(PAGE).toContain("(history[id]?.length ?? 0) >= ROUTINE_HISTORY_MAX");
    expect(PAGE).toContain('tr("routines.historyLoadingOlder")');
    expect(PAGE).toContain('tr("routines.historyLoadOlder")');
  });
});
