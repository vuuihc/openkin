import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The page-level half of the archive.
 *
 * The rules themselves live in modules with their own tests —
 * `sessionFeed.test.ts` (which rows a scope shows), `phoneSessionBuckets.test.ts`
 * (the per-conversation flag against the project rule) and
 * `liveResources.test.ts` (a live frame crossing the archive). What is left is
 * the wiring a reviewer cannot see from any of them: which call the row's
 * archive makes, what the archive view asks the daemon for, and which headings
 * carry a project Restore. Drop one and the page still renders and still
 * filters; it just archives the wrong thing or offers an action that does
 * nothing, which is only visible by tapping it.
 *
 * Source rather than DOM, like the other page wiring tests: mounting this page
 * needs a daemon, a machine list and two live subscriptions.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE = readFileSync(join(UI, "src/pages/SessionsPage.tsx"), "utf8");
const TASK_DETAIL = readFileSync(join(UI, "src/pages/TaskDetailPage.tsx"), "utf8");

describe("the phone list's archive wiring", () => {
  it("archives the conversation, not its project", () => {
    // The bug this round exists for: one row's 归档 used to hide every chat
    // filed under the same cwd. The row call has to be the per-task one. The
    // project's own restore stays — it is the drawer's action, not this one.
    expect(SOURCE).toContain("const archived = await archiveTask(id);");
    expect(SOURCE).not.toMatch(/\barchiveProject\(/);
    expect(SOURCE).toContain("unarchiveProject(cwd);");
  });

  it("asks for the archive's own feed only while that view is open", () => {
    // The feed is a second request; every other screen would pay for rows it
    // never reads. The scope is the enable flag, and the params carry the
    // archive side of the list.
    expect(SOURCE).toContain("sessionListParams(searchTerm, status, true)");
    expect(SOURCE).toContain('scope === "archived",');
  });

  it("applies the daemon's answer as a normal live update", () => {
    // Both the row and the session sheet take the row the archive endpoint
    // returns and hand it to the live store: the list, the other feed and the
    // drawer all read the same task.
    expect(SOURCE).toContain(
      "liveResources.applyMessage({ kind: \"task_update\", data: archived })",
    );
    expect(SOURCE).toContain(
      "liveResources.applyMessage({ kind: \"task_update\", data: live })",
    );
  });

  it("offers a project Restore only on a heading that stands for one", () => {
    // The archive view now holds conversation rows whose project was never
    // archived. Their heading has no stored entry, and a Restore button there
    // would be a tap that does nothing.
    expect(SOURCE).toContain('scope === "archived" && archivedCwdFor(bucket.key, archivedCwds)');
  });

  it("gives an archived conversation its restore strip, not the list's", () => {
    // The strip is chosen from the row's own flag first: a conversation put
    // away on its own uncovers restore + delete even when its project is
    // still filed.
    expect(SOURCE).toContain("const mode: SessionRowActionMode | null = row.task.archived_at");
  });

  it("pages each feed from its own tail", () => {
    // The archive view holds two lists at once. Paging the combined array's
    // tail hands the live feed a cursor from the archive (or the reverse),
    // which repeats or skips a page; and the archive feed has to be paged at
    // all, or its second page cannot be reached from the phone.
    expect(SOURCE).toContain("const oldest = liveRows[liveRows.length - 1]?.id;");
    expect(SOURCE).toContain("const oldest = archivedRows[archivedRows.length - 1]?.id;");
    expect(SOURCE).toContain("...sessionListParams(searchTerm, status, true),");
  });

  it("waits for the archive feed before calling it empty, and says when it failed", () => {
    // The archive view renders an empty state when no rows are listed, so the
    // archive fetch has to hold that state back while it is in flight and
    // surface its error once it is done; otherwise "Nothing archived" is what
    // a slow or broken daemon looks like. It only waits when it has nothing to
    // show: a settled search keeps the retained archive on screen instead.
    expect(SOURCE).toContain("scope === \"archived\" &&");
    expect(SOURCE).toContain("!archivedList.loaded &&");
    expect(SOURCE).toContain("lastLoadedArchivedTasks.current.length === 0;");
    expect(SOURCE).toContain("|| archiveWaiting;");
    // The failure states ask the rendered list, not the raw feed: the live
    // side can be non-empty while this view shows nothing at all, and then
    // "Nothing archived" would stand next to the error.
    expect(SOURCE).toContain(
      "const loadFailed = (Boolean(taskList.error) || archiveFailed) && listed.length === 0;",
    );
    expect(SOURCE).toContain("(archiveFailed || archiveProjectsFailed) && listed.length > 0");
    expect(SOURCE).toContain('? "sessions.archiveLoadFailed"');
    expect(SOURCE).toContain(': "sessions.archiveProjectsLoadFailed"');
  });

  it("keeps the previous archive on screen while a settled search answers", () => {
    // The archive feed is keyed by the settled term; the hook hands back an
    // empty resource until the server replies, and without a retained copy the
    // whole view blinks to a spinner on every pause in typing. A failed re-ask
    // keeps the retained copy rather than overwriting it with nothing.
    expect(SOURCE).toContain("const lastLoadedArchivedTasks = useRef<readonly Task[]>([]);");
    expect(SOURCE).toContain("if (archivedList.loaded && !archivedList.error) {");
    // The store marks a failed answer `loaded`; rendering its empty data would
    // turn a failed re-ask into "the archive is empty".
    expect(SOURCE).toContain(
      "archivedList.loaded && !archivedList.error\n      ? archivedList.data\n      : lastLoadedArchivedTasks.current;",
    );
  });

  it("asks the feed's own answer whether the page was full, not the shrinking list", () => {
    // The list shrinks when a row is archived or restored, so a full first
    // page minus one moved row would read as "the end" and hide the tail. The
    // resource records the answer before live updates touch it; the page must
    // read that, and only a paged tail may override it. The length terms are
    // the other direction: a short answer that later filled up means rows were
    // evicted from the loaded window, so more exist below it.
    expect(SOURCE).toContain(
      "const hasMoreTasks = taskMore ?? (taskList.pageFull || liveTasks.length >= taskLimit);",
    );
    expect(SOURCE).toContain(
      "(archiveMore ?? (archivedList.pageFull || archivedTasks.length >= archiveLimit))",
    );
    expect(SOURCE).not.toContain("liveRows.length >= taskLimit");
    expect(SOURCE).not.toContain("taskList.data.length >= taskLimit");
  });

  it("re-acquires the archive's tail when the view is entered again", () => {
    // The feed is released when the view closes and may be fetched from
    // scratch on re-entry; the previous visit's tail and its "more" answer do
    // not describe the new one.
    expect(SOURCE).toContain("if (scope !== \"archived\") return;");
    expect(SOURCE).toContain("setArchiveMore(null);");
    expect(SOURCE).toContain("setOlderArchivedTasks([]);");
  });

  it("lets an archived conversation start a selection, and only one", () => {
    // The archive view's batch action is Restore, so a selection there has to
    // be enterable at all; which rows it may hold is `sessionSelection`'s
    // rule, and the row's checkbox, tap, keyboard and select-all all read it.
    expect(SOURCE).toContain("if (!rowSelectable(row, scope)) return;");
    expect(SOURCE).toContain("onClick={scope === \"archived\" ? restoreSelected : archiveSelected}");
    expect(SOURCE).toContain("selectionMode && rowSelectable(row, scope) ? (");
    expect(SOURCE).toContain("new Set(selectableTaskIds(listed, scope))");
    expect(SOURCE).toContain("const present = new Set(selectableTaskIds(listed, scope));");
    expect(SOURCE).toContain("const selectableCount = selectableTaskIds(listed, scope).length;");
    // Pin orders the live list; the archive view never shows a pinned bucket,
    // so the chip would be a button with no visible effect.
    expect(SOURCE).toContain(
      "{scope !== \"archived\" && (\n              <button\n                type=\"button\"\n                onClick={pinSelected}",
    );
  });

  it("offers Restore, not Archive, on a batch selected in the archive", () => {
    // Every row there is archived already; Archive would re-stamp the date and
    // move nothing, leaving the person with a batch that "worked" and a
    // selection that did not change.
    expect(SOURCE).toContain(
      "onClick={scope === \"archived\" ? restoreSelected : archiveSelected}",
    );
    expect(SOURCE).toContain("settleArchiveBatch(ids, results)");
    expect(SOURCE).toContain(
      'tr(archived ? "sessions.archiveFailedCount" : "sessions.restoreFailedCount", {',
    );
  });

  it("refuses a second batch and ignores one that answered a list nobody sees", () => {
    // The in-flight guard is what keeps a double tap from firing two rounds at
    // the same rows; the epoch is what keeps a slow answer from putting rows
    // back into a toolbar after a search or a scope change cleared it.
    expect(SOURCE).toContain("if (archivingSelectionRef.current) return;");
    expect(SOURCE).toContain("if (selectionEpoch.current !== epoch) return;");
  });

  it("leaves the session sheet only while that row is still the one on screen", () => {
    // Archiving a conversation closes its page; a slow answer must not pull
    // the person off the conversation they opened while it was in flight.
    expect(TASK_DETAIL).toContain(
      'if (!wasArchived && taskIdRef.current === task.id) navigate("/");',
    );
  });
});
