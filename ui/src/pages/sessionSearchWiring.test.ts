import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Wiring the page cannot be trusted to keep by itself.
 *
 * The behaviour these point at is covered where it can be: the parameter rule
 * in `sessionListParams.test.ts`, the local predicate in
 * `phoneSessionBuckets.test.ts`, the mark in `highlightMatch.test.ts` and
 * `HighlightedText.test.tsx`. What is left is the wiring that has no unit of
 * its own — which request carries the term and the status, which one carries
 * the paging bound, and whether the imported-session read follows the query.
 * Drop any of them and nothing else fails: the page still renders, still
 * filters the loaded rows, and simply cannot find anything older than the first
 * page, which reads as "the conversation is gone".
 *
 * Source rather than DOM, like `phoneRunConfigFace.test.ts`: mounting this page
 * needs a daemon, a machine list and two live subscriptions.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE = readFileSync(join(UI, "src/pages/SessionsPage.tsx"), "utf8");
/** The selection rule moved to its own module so it can be tested without a daemon. */
const FEED = readFileSync(join(UI, "src/lib/sessionFeed.ts"), "utf8");

const count = (needle: string) => SOURCE.split(needle).length - 1;

describe("the phone list's search wiring", () => {
  it("builds the task requests from the shared parameter rule", () => {
    // The live list, the "is there more" bound, and the older page all ask the
    // same question; a request that forgot the status would append unfiltered
    // rows under a filtered list.
    expect(count("sessionListParams(searchTerm, status)")).toBe(3);
  });

  it("builds the imported-session requests without a status", () => {
    // Imported sessions have no status, so the page hides them while a filter
    // is on instead of asking for a page that cannot match it. Both the effect
    // and "load older" use the status-free call.
    expect(count("sessionListParams(searchTerm)")).toBe(2);
  });

  it("reads both filters from the URL through their normalizers", () => {
    // A filter has to survive a reload and be linkable, like the query; and an
    // unknown value has to fall back to "all" rather than an empty list.
    expect(SOURCE).toContain('normalizeStatusFilter(params.get("status"))');
    expect(SOURCE).toContain('normalizeScopeFilter(params.get("scope"))');
  });

  it("re-reads imported sessions when the query settles", () => {
    // The effect owns that fetch. A missing dependency leaves the task list
    // searching while the imported sessions keep answering the old query.
    expect(SOURCE).toContain("[searchTerm]");
  });

  it("keeps the previous answer on screen while the next one loads", () => {
    // The settled query is a new live-list key, and the hook returns an empty
    // unloaded resource until it answers. Without a retained snapshot the page
    // blinks to "loading" on every pause in typing.
    expect(SOURCE).toContain("lastLoadedTasks");
  });

  it("pages from the oldest loaded row, not from the top", () => {
    // `before` is exclusive. Without it the second request is page one again:
    // the dedupe hides the repeats, so the button visibly does nothing and the
    // list looks like it ended.
    expect(SOURCE).toContain("before: oldest");
    expect(SOURCE).toContain("before: sessionCursor");
  });

  it("does not page imported sessions under a status filter", () => {
    // The cursor belongs to a status-free feed. Paging it while the page is
    // hiding those rows would fetch pages nobody sees and never reach the end.
    expect(SOURCE).toContain("Boolean(sessionCursor) && !status");
  });

  it("tells a failed request apart from an empty library", () => {
    expect(SOURCE).toContain("taskList.error");
  });

  it("narrows the merged list locally as well as on the server", () => {
    // The server page is authoritative but not instant: between the filter
    // change and its answer the list still holds the previous page, and a row
    // the tail carries may have finished a moment ago. Without this line both
    // flash under a status they no longer match. It lives in `sessionFeed.ts`
    // now, where it is covered directly; what this pins is that the page asks
    // it for every scope instead of carrying a second copy of the rule.
    expect(FEED.split("task.status === status").length - 1).toBe(1);
    expect(SOURCE).toContain("sessionFeedTasks(liveRows, archivedRows, scope, status)");
  });

  it("reconciles the older page with the live store", () => {
    // The tail is outside the registered lists, so the store neither prunes a
    // deleted row from it nor refreshes a changed one; the page has to ask per
    // row at render time.
    expect(count("mergeTaskTail(liveTasks, olderTasks")).toBe(1);
    expect(SOURCE).toContain("liveResources.taskSnapshot(id)");
  });

  it("ignores a page that lands after the filter moved on", () => {
    // Every feed checks the generation its request started in: a slow answer
    // for the previous filter must not append rows under this one, and a stale
    // cursor must not keep paging from it. Three feeds page here — the live
    // list, the archive's own list and the imported sessions.
    expect(count("requestGeneration.current !== generation")).toBe(3);
  });
});
