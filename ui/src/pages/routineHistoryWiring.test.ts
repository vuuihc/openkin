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

  it("asks for one bounded summary page and records its independent cursor", () => {
    const read = PAGE.slice(
      PAGE.indexOf("const readHistory ="),
      PAGE.indexOf("const loadHistory ="),
    );
    expect(read).toContain("await listRoutineRuns(");
    expect(read).toContain("ROUTINE_HISTORY_PAGE,");
    expect(read).toContain('remote ? view.deviceId : "",');
    expect(read).toContain("before,");
    expect(read).toContain("id,");
    expect(read).toContain("page.runs_has_more ?? false");
    expect(read).toContain('page.runs_next_cursor ?? ""');
  });

  it("pages older runs from the boundary the last page returned", () => {
    // `before` is the daemon's ULID cursor. It must come from the page, not
    // from the list's tail: a live push can place a deeper run at the tail, and
    // asking below that id would skip every run between the two.
    expect(PAGE).toContain("return before ? readHistory(id, before) : Promise.resolve();");
    expect(PAGE).toContain(
      'setHistoryCursor((prev) => ({ ...prev, [id]: page.runs_next_cursor ?? "" }));',
    );
    expect(PAGE).toContain("before ? appendOlderRuns(prev[id] ?? [], tasks) : tasks");
  });

  it("applies a page only after the newer-wins guard", () => {
    // The summary API, not the retained row count, owns the cursor and has-more.
    // Both local and relay paths run this same reader; all state writes wait
    // for the per-routine generation / current-device check after its await.
    const read = PAGE.slice(
      PAGE.indexOf("const readHistory ="),
      PAGE.indexOf("const loadHistory ="),
    );
    const awaited = read.indexOf("await listRoutineRuns(");
    const guarded = read.search(/if \(\s*historySeq\.current\[id\] !== seq \|\|/);
    const applied = read.indexOf("setHistory((prev) =>");
    const hasMore = read.indexOf("setHistoryHasMore((prev) =>");
    const cursor = read.indexOf("setHistoryCursor((prev) =>");
    expect(awaited).toBeGreaterThan(-1);
    expect(guarded).toBeGreaterThan(awaited);
    expect(applied).toBeGreaterThan(guarded);
    expect(hasMore).toBeGreaterThan(guarded);
    expect(cursor).toBeGreaterThan(guarded);
  });

  it("reconciles both local and relay reads against what the reader marked read", () => {
    expect(PAGE).toContain("readAllEpoch.current !== epoch,");
    expect(PAGE).toContain("knownRead.current,");
    expect(PAGE).toContain("const epoch = readAllEpoch.current;");
    expect(PAGE).toContain("readAllEpoch.current += 1;");
  });

  it("discards an older page that a re-open has made stale", () => {
    // The cursor belongs to the list the re-open replaced; appending would skip
    // the rows between the two pages and could hide the button with a short
    // page. Every fetch path has the newest-wins guard.
    expect(PAGE).toContain("const seq = (historySeq.current[id] ?? 0) + (before ? 0 : 1);");
    const read = PAGE.slice(
      PAGE.indexOf("const readHistory ="),
      PAGE.indexOf("const loadHistory ="),
    );
    expect(read.split("historySeq.current[id] !== seq").length - 1).toBe(2);
    expect(read).toContain("historySeq.current[id] = seq;");
    expect(read).toContain(
      "if (historySeq.current[id] === seq && historyOlderSeq.current[id] === olderSeq)",
    );
    expect(read).toContain("if (historyOlderSeq.current[id] === olderSeq)");
  });

  it("keeps the history branches in loading / error / empty order", () => {
    // A failed fetch must not read as "this routine has never run", and a
    // loading state must not flash the empty line underneath it. The order
    // lives in the panel that both the phone row and the desktop aside mount.
    const panel = PAGE.slice(
      PAGE.indexOf("function RunHistoryPanel"),
      PAGE.indexOf("function RunCard"),
    );
    const loading = panel.indexOf("{loading ? (");
    const failure = panel.indexOf(") : error ? (");
    const empty = panel.indexOf(") : runs.length === 0 ? (");
    expect(loading).toBeGreaterThan(-1);
    expect(failure).toBeGreaterThan(loading);
    expect(empty).toBeGreaterThan(failure);
  });

  it("loads the history when the editor opens", () => {
    const edit = PAGE.slice(PAGE.indexOf("const openEdit ="), PAGE.indexOf("const onSubmit ="));
    // The row selector has the same call; checking the whole page used to pass
    // even after editing had lost its history read and rendered "No runs yet".
    expect(edit).toContain("void loadHistory(r.id);");
  });

  it("offers the older page only for an explicit cursor and below the cap", () => {
    // Both local and remote carry runs_has_more / runs_next_cursor. The panel
    // has one answer for both, but asks only while the reader is below the cap.
    expect(PAGE).toContain("{hasMore && runs.length < ROUTINE_HISTORY_MAX && (");
    expect(PAGE).toContain("hasMore={!!historyHasMore[r.id]}");
    expect(PAGE).toContain("hasMore={!!historyHasMore[selected.id]}");
    // And the fetch refuses too: a long-lived editor whose list fills between
    // the render and the click must not ask for rows the merge would drop.
    expect(PAGE).toContain("(history[id]?.length ?? 0) >= ROUTINE_HISTORY_MAX");
    expect(PAGE).toContain('tr("routines.historyLoadingOlder")');
    expect(PAGE).toContain('tr("routines.historyLoadOlder")');
  });
});
