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
 * old title.
 *
 * Source rather than DOM, like the other page wiring tests: mounting this page
 * needs a daemon, a machine list and two live subscriptions.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE = readFileSync(join(UI, "src/components/sessions/SessionList.tsx"), "utf8");

describe("the page's rename wiring", () => {
  it("SessionList persists the row's new title", () => {
    expect(SOURCE).toContain(
      'import { getLocalTaskTitles, setLocalTaskTitle, subscribeTaskTitles } from "../../lib/taskTitles";',
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
    expect(SOURCE).toContain(
      "useEffect(() => subscribeTaskTitles(() => setLocalTitles(getLocalTaskTitles())), []);",
    );
  });
});
