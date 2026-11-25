import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * KIN-CONTINUE-001: the phone list's imported-session group, checked at the
 * seam the unit tests cannot see.
 *
 * `phoneSessionBuckets.test.ts` owns the rule — one trailing group per machine,
 * imports never become projects, folds sort after everything else, and
 * `isBucketCollapsed` decides which set a fold lives in. What is left here is
 * the page's own wiring: which state says a group is open, what the heading
 * counts, and that the page asks `isBucketCollapsed` rather than re-deriving
 * the rule inline. Break one and the pure functions still pass while the page
 * hides imports behind a fold that cannot be opened, or shows a count that is
 * not the number of rows it holds.
 *
 * Source rather than DOM: mounting this page needs a daemon, a machine list and
 * two live subscriptions (see `sessionSearchWiring.test.ts`).
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE = readFileSync(join(UI, "src/components/sessions/SessionList.tsx"), "utf8");
const FOLDS = readFileSync(join(UI, "src/lib/sessionListFolds.ts"), "utf8");

describe("the phone list's imported group", () => {
  it("folds a machine's imports until the reader opens them", () => {
    // Imports start closed: the default-fold rule keeps an imported group
    // folded whatever its rows' clock says, a real project opens only when it
    // holds the newest conversation, and both persist one entry per machine +
    // place. KIN-CONTINUE-007 moved the default out of this file and into the
    // pure resolver, so the page must ask it rather than re-derive it.
    expect(SOURCE).toContain("resolveSessionListFolds(foldCandidates, folds)");
    expect(FOLDS).toContain("resolved[candidate.stateKey] = candidate.imported");
    expect(SOURCE).toContain("setSessionFold(stateKey, !foldIsOpen(stateKey, imported))");
    expect(SOURCE).toContain("collapsed={isBucketCollapsed({");
  });

  it("lets a search open every fold, imports included", () => {
    // A matching row under a closed fold is invisible, and a click that
    // re-folds it is a no-op; the rule itself lives in `isBucketCollapsed`.
    expect(SOURCE).toContain("searching,");
    expect(SOURCE).toContain("canToggle={!searching}");
  });

  it("counts the rows the group holds and names the heading with it", () => {
    // The count is drawn from the bucket itself, so a fold and its number can
    // never disagree; the accessible name is the same string, not the bare
    // "Imported sessions" a highlight would leave behind mid-search.
    expect(SOURCE).toContain('tr("sessions.imported", { count: String(bucket.rows.length) })');
    expect(SOURCE).toContain("aria-label={heading}");
  });

  it("draws the conversation mark instead of a project folder", () => {
    // An import is not a project: a folder icon would promise a project page
    // and pin, archive and cover actions that do not apply.
    expect(SOURCE).toContain("{imported ? (\n            <IconSessions");
  });
});
