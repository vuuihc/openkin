import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The page-level half of deleting a selection.
 *
 * The hook's own contract (ask, then drop only confirmed ids, report what
 * survived) is covered in `useSessionDeletion.test.tsx`, and the chips in
 * their DOM tests. What is left is the wiring a reviewer cannot see from
 * either side: the page must delegate the confirmation instead of asking
 * twice, keep exactly the refused rows selected, refuse a second batch while
 * one is in flight, and not leave a selection armed over a list the person
 * has since filtered away.
 *
 * Source rather than DOM, like `sessionSearchWiring.test.ts`: mounting this
 * page needs a daemon, a machine list and two live subscriptions.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE = readFileSync(join(UI, "src/components/sessions/SessionList.tsx"), "utf8");
// The delete chip moved to SessionToolbar with the toolbar extraction; the list
// still owns the in-flight guard and the selection it acts on.
const TOOLBAR = readFileSync(join(UI, "src/components/sessions/SessionToolbar.tsx"), "utf8");
const ROW = readFileSync(join(UI, "src/components/sessions/SessionRow.tsx"), "utf8");

describe("the phone list's delete wiring", () => {
  it("delegates the confirmation and the requests to the shared hook", () => {
    // A second confirm, or a direct `deleteTask`, would be a second behaviour
    // to keep in step with the row path and every other delete in the console.
    // Scoped to the two delete paths: the project heading's archive is a
    // different action and keeps its own confirmation.
    expect(SOURCE).toContain("useSessionDeletion()");
    const deletePaths =
      SOURCE.slice(
        SOURCE.indexOf("async function deleteRow"),
        SOURCE.indexOf("function forgetPins"),
      ) +
      SOURCE.slice(
        SOURCE.indexOf("async function deleteSelected"),
        SOURCE.indexOf("async function loadOlder"),
      );
    expect(deletePaths).toContain("deleteOne(");
    expect(deletePaths).toContain("deleteMany(");
    expect(deletePaths).not.toContain("window.confirm");
    expect(SOURCE).not.toContain("deleteTask(");
  });

  it("keeps the rows the daemon refused selected", () => {
    // Losing the selection after a failed batch is a destructive action that
    // did nothing but still made the person rebuild their selection to retry.
    expect(SOURCE).toContain("setSelectedIds(new Set(outcome.failed))");
  });

  it("leaves the selection alone when the confirmation is declined", () => {
    expect(SOURCE).toContain("if (outcome === null) return;");
  });

  it("refuses a second batch while one is in flight", () => {
    // A second tap would confirm again, fire a second round at rows the first
    // is deleting, and turn its success into a round of "not found" errors.
    expect(SOURCE).toContain("if (deletingSelectionRef.current) return;");
    // The delete chip specifically: matching the expression anywhere would
    // still pass if only pin and archive kept their guard. The busy state is
    // shared with the archive batch, so neither can start during the other —
    // both write the selection, and the second would act on rows the first is
    // already changing.
    expect(TOOLBAR).toContain(
      "onClick={onDelete}\n          disabled={selectedCount === 0 || selectionBusy}",
    );
    expect(TOOLBAR).toContain(
      "onClick={onArchiveOrRestore}\n          disabled={selectedCount === 0 || selectionBusy}",
    );
    // Row taps would change the selection the batch captured while it runs.
    expect(SOURCE).toContain("selectionLocked={selectionBusy}");
    // The tap path specifically: the keyboard path has the same guard, so a
    // bare substring would still pass if only one of them kept it.
    expect(ROW).toContain("if (rowSelectable(row, scope) && !selectionLocked) onToggleSelect();");
  });

  it("clears a selection the visible list no longer shows", () => {
    // Select all, then search, then Delete would remove rows invisible under
    // the new question; the filter change has to disarm the selection, and
    // switching sides of the archive is the same kind of change.
    expect(SOURCE).toContain("}, [query, status, scope]);");
  });

  it("drops a selected id whose row has left the list", () => {
    // A 404 from another device's delete leaves the id selected with no row:
    // the count and the select-all checkbox would describe nothing.
    expect(SOURCE).toContain(
      "if (next.length !== selectedIds.size) setSelectedIds(new Set(next));",
    );
  });

  it("drops a deleted conversation from the pin preference", () => {
    // A pinned row that was deleted has no row to render, but its id would
    // otherwise sit in localStorage forever.
    expect(SOURCE).toContain("const current = new Set(getPinnedTaskIds());");
    expect(SOURCE).toContain("setTaskPinned(id, false)");
  });
});
