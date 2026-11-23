import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * KIN-MANAGE-001, step 5: the page's half of a rename.
 *
 * The rules themselves live in `taskTitles.test.ts` (storage) and
 * `phoneSessionBuckets.titles.test.ts` (display and search). What is left is
 * the wiring that has no unit of its own: `SessionList` has to write the map,
 * hand it to the bucketing call, and listen to it — drop the state from the
 * memo's dependencies and a rename updates storage while the list keeps the
 * old title. The tab strip has to listen too: its labels are drawn from the
 * local store and a rename never reaches the live feed, so a strip that only
 * reads at render keeps the old name indefinitely.
 *
 * Source rather than DOM, like the other page wiring tests: mounting this page
 * needs a daemon, a machine list and two live subscriptions.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const source = (path: string) => readFileSync(join(UI, "src", path), "utf8");
const SOURCE = source("components/sessions/SessionList.tsx");
const STORE = source("lib/taskTitles.ts");
const HOST = source("pages/TaskSessionHost.tsx");

describe("the page's rename wiring", () => {
  it("SessionList persists the row's new title", () => {
    expect(SOURCE).toContain(
      'import { setLocalTaskTitle, useLocalTaskTitles } from "../../lib/taskTitles";',
    );
    // The lib returns the new map either way (a refused write included), so
    // the page renders from the returned value rather than reading again.
    expect(SOURCE).toContain("setLocalTitles(setLocalTaskTitle(row.task.id, title))");
  });

  it("the row list recomputes after a rename", () => {
    const start = SOURCE.indexOf("const buckets = useMemo(");
    expect(start).toBeGreaterThan(-1);
    const block = SOURCE.slice(start, SOURCE.indexOf("const canSeed"));
    // The state goes in with the call and in the dependency array; only the
    // second one makes the list draw the new title on the next commit.
    const deps = block.slice(block.lastIndexOf("["));
    expect(deps).toContain("localTitles");
  });

  it("the row receives the rename handler", () => {
    expect(SOURCE).toContain("onRename={(title) => onRename(row, title)}");
  });

  it("the list re-reads a title written by another surface", () => {
    // The list is not the only reader of the map: a rename written from the
    // conversation header has to reach rows the list already drew, so the
    // page subscribes instead of only keeping the map it wrote itself.
    expect(SOURCE).toContain("const [localTitles, setLocalTitles] = useLocalTaskTitles();");
  });

  it("the tab strip draws the rename and hears the store", () => {
    // A tab's label is a name of the same conversation. It reads the local map
    // at render, so it must also be subscribed: a rename never reaches the
    // live feed, and an idle conversation has no other event to repaint it.
    expect(HOST).toContain("const [localTitles] = useLocalTaskTitles();");
    expect(HOST).toContain("taskDisplayTitle(tasksById.get(id), localTitles)");
  });

  it("the project cover draws its recent row from the subscribed map", () => {
    // The cover's one conversation row is a name like any other. It used to
    // read the map only when the activity feed landed, so a rename from the
    // sidebar left the old name on screen until the reader left and came back.
    const COVER = source("pages/ProjectDetailPage.tsx");
    expect(COVER).toContain("taskDisplayTitle(row.task, localTitles)");
    // The cached row follows the rename too, or an offline reopen paints the
    // name the read returned instead of the one the reader typed.
    expect(COVER).toContain("latest: activityCurrent ? drawnLatest : null");
  });

  it("every name-drawing surface subscribes through the one hook", () => {
    // One place owns the `useState` + `subscribeTaskTitles` pair; a surface
    // that copies it can (and did) forget the listener.
    expect(STORE).toContain(
      "useEffect(() => subscribeTaskTitles(() => setTitles(getLocalTaskTitles())), []);",
    );
    for (const path of [
      "components/sessions/SessionList.tsx",
      "components/task/TaskHeader.tsx",
      "pages/TaskSessionHost.tsx",
      "pages/ProjectDetailPage.tsx",
    ]) {
      const reader = source(path);
      expect(reader, path).toContain("useLocalTaskTitles()");
      expect(reader, path).not.toContain("subscribeTaskTitles");
    }
  });
});
