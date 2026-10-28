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
 * its own — which request carries the term, and whether the imported-session
 * read follows it. Drop either and nothing else fails: the page still renders,
 * still filters the loaded rows, and simply cannot find anything older than the
 * first page, which reads as "the conversation is gone".
 *
 * Source rather than DOM, like `phoneRunConfigFace.test.ts`: mounting this page
 * needs a daemon, a machine list and two live subscriptions.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE = readFileSync(join(UI, "src/pages/SessionsPage.tsx"), "utf8");

const count = (needle: string) => SOURCE.split(needle).length - 1;

describe("the phone list's search wiring", () => {
  it("builds both requests from the shared parameter rule", () => {
    // One for Kin's tasks, one for imported agent sessions: a search covering
    // only one of them looks complete and is not.
    expect(count("sessionListParams(searchTerm)")).toBe(2);
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

  it("tells a failed request apart from an empty library", () => {
    expect(SOURCE).toContain("taskList.error");
  });
});
