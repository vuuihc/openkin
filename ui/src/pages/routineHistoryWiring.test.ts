import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A routine's own run history, guarded where a unit cannot reach.
 *
 * The section only exists inside the edit form, which needs a daemon, a task
 * feed, an agent list and a router to mount. What is pinned here is the seam:
 * that opening a routine asks for that routine's runs, that the section reads
 * the same rows and the same mark-read path as the global feed, and that a
 * failed fetch is not shown as "never ran".
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const PAGE = readFileSync(join(UI, "src/pages/RoutinesPage.tsx"), "utf8");

/** The source between two markers, so a test can speak about one function. */
function block(start: string, end: string): string {
  const from = PAGE.indexOf(start);
  const to = PAGE.indexOf(end, from + start.length);
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return PAGE.slice(from, to);
}

describe("a routine's run history", () => {
  it("asks the daemon for the routine that was opened", () => {
    // Inside openEdit, not merely somewhere on the page.
    const openEdit = block("const openEdit = (r: Routine) => {", "const onSubmit = async");
    expect(openEdit).toContain("void loadHistory(r.id);");
  });

  it("draws the history with the feed's row, so both mark read the same way", () => {
    const section = block("{editing && (", "          </section>");
    expect(section).toContain('tr("routines.historyTitle")');
    expect(section).toContain("history[editing.id].map((run) => (");
    expect(section).toContain("onMarkRead={onMarkRead}");
    // The routine id on every row is noise under that routine's own editor.
    expect(section).toContain("ownRoutine");
    expect(PAGE).toContain("{!ownRoutine && run.routine_id ?");
    // Marking a run read from the history has to clear it in the history too,
    // not only in the feed above.
    const markRead = block("const onMarkRead = async", "const loadHistory = async");
    expect(markRead).toContain("setHistory((prev) => {");
    expect(markRead).toContain("return { ...x, ...t, routine_unread: false };");
    expect(markRead).toContain("knownRead.current.add(taskId);");
    // "Mark all read" is on the same screen as the open history.
    const markAll = block("const onMarkAllRead = async", "const resetForm");
    expect(markAll).toContain("setHistory((prev) => {");
    expect(markAll).toContain("readAllEpoch.current += 1;");
  });

  it("does not call a failed fetch an empty history", () => {
    const load = block("const loadHistory = async", "const onMarkAllRead");
    expect(load).toContain("const tasks = await listTasks({ routineId: id, limit: 10 });");
    expect(load).toContain("setHistoryError((prev) => ({");
    expect(load).toContain("if (!id) return;");
    // A reopened routine's older fetch must not overwrite the newer list, nor
    // write its error, nor clear the spinner the newer fetch owns.
    expect(load.split("if (historySeq.current[id] !== seq) return;").length - 1).toBe(2);
    expect(load).toContain("if (historySeq.current[id] === seq) {");
    // A mark write that landed while the fetch was out beats its snapshot.
    expect(load).toContain("const allRead = readAllEpoch.current !== epoch;");
    expect(load).toContain("allRead || read.has(x.id) ? { ...x, routine_unread: false } : x");
    expect(PAGE).toContain("historyLoading[editing.id] ?");
    expect(PAGE).toContain("historyError[editing.id] ?");
    expect(PAGE).toContain("(history[editing.id]?.length ?? 0) === 0 ?");
    expect(PAGE).toContain('tr("routines.historyEmpty")');
    // Order matters: a swap would show "No runs yet." for a failed fetch
    // whenever nothing is cached, and every string above would still be there.
    const section = block("{editing && (", "          </section>");
    const order = [
      "historyLoading[editing.id] ?",
      "historyError[editing.id] ?",
      "(history[editing.id]?.length ?? 0) === 0 ?",
    ].map((needle) => section.indexOf(needle));
    expect(order.every((at) => at > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
