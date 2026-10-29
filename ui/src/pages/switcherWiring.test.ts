import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The phone's session switcher, guarded where no unit can reach.
 *
 * `sessionSwitcher.test.ts` holds the row model and
 * `SessionSwitcherSheet.dom.test.tsx` the sheet. What is left is the seam
 * between them and the app: the host that assembles the rows from two live
 * subscriptions, and the header button that opens it. Each piece below fails
 * silently on its own — a sheet nobody can open, or rows that never say
 * "waiting" — so each gets a line here.
 *
 * Source rather than DOM, like `findWiring.test.ts`: mounting the host needs a
 * daemon, a task list, an approval feed and a router.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const HOST = readFileSync(join(UI, "src/pages/TaskSessionHost.tsx"), "utf8");
const DETAIL = readFileSync(join(UI, "src/pages/TaskDetailPage.tsx"), "utf8");

describe("the phone's session switcher", () => {
  it("is reachable from the session header", () => {
    // The tab strip above the chat is desktop-only, so this button is the
    // phone's only way between two live sessions.
    expect(DETAIL).toContain("onOpenSessionSwitcher");
    expect(DETAIL).toContain('label={tr("switcher.title")}');
    // It must be offered only where the host can actually open it: a header
    // button that swallows taps is worse than no button.
    expect(DETAIL).toContain("onOpenSessionSwitcher &&");
    expect(HOST).toContain("onOpenSessionSwitcher={openSwitcher}");
  });

  it("draws the sheet the host assembled", () => {
    expect(HOST).toContain("<SessionSwitcherSheet");
    expect(HOST).toContain("rows={switcherRows}");
    expect(HOST).toContain("buildSwitcherRows({");
  });

  it("feeds it the block state the task status cannot show", () => {
    // A session stopped on an approval stays `running`, so the pending feeds
    // are the only place the "waiting" mark can come from.
    expect(HOST).toContain("waitingTaskIds(pending.data.approvals, pending.data.questions)");
    expect(HOST).toContain("usePendingResources()");
  });

  it("counts asking what is new as having read the session in front", () => {
    // Opening the sheet on a finished session marks it seen — otherwise the
    // row the reader is looking at comes back marked "new result". The write
    // lives in the open handler, not in an always-on effect: the desktop
    // sidebar deliberately keeps its green dot for a session watched to
    // completion, and this control exists only on the phone.
    expect(HOST).toContain("markSessionViewed(activeId)");
    expect(HOST).toContain("const openSwitcher = useCallback(");
    expect(HOST).toContain("subscribeSessionViewed");
    // The snapshot must be a string: `getViewedSessionIds()` returns a fresh
    // array, and `useSyncExternalStore` compares snapshots with Object.is — a
    // fresh array would re-render forever.
    expect(HOST).toContain('.slice().sort().join(",")');
  });
});
