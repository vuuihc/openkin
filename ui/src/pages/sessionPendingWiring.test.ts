import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * R0b-2a: the phone list's waiting count, and the wiring that gets it there.
 *
 * The inbox used to be where unanswered work was found, and its replacement is
 * a number at the end of the conversation row. The parts have their own tests —
 * `pendingCounts.test.ts` for the sum, `PendingBadge.dom.test.tsx` for the chip,
 * `Sidebar.dom.test.tsx` for the Mac row — and what is left is the phone page's
 * wiring: that the count comes from the pending list the floating card already
 * reads rather than a second poll, that it reaches the row by task id, and that
 * the row says it in words as well as in orange. Drop any of them and the page
 * still renders; the one thing the badge exists to say is simply absent.
 *
 * Source rather than DOM, like `sessionSearchWiring.test.ts`: mounting this page
 * needs a daemon, a machine list and two live subscriptions.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE = readFileSync(join(UI, "src/components/sessions/SessionList.tsx"), "utf8");
const ROW = readFileSync(join(UI, "src/components/sessions/SessionRow.tsx"), "utf8");

const count = (needle: string) => SOURCE.split(needle).length - 1;

describe("the phone list's waiting count", () => {
  it("reads the pending list the floating card reads, once", () => {
    // A second subscription would be a second poll, and the two could disagree
    // about what is still waiting.
    expect(count("usePendingResources()")).toBe(1);
    expect(SOURCE).toContain("pendingCountsByTask(pending.data)");
  });

  it("hands the per-task counts down to the rows", () => {
    expect(count("pendingByTask={pendingByTask}")).toBe(1);
    expect(SOURCE).toContain(
      "pending={row.task ? (pendingByTask.get(row.task.id) ?? EMPTY_PENDING) : EMPTY_PENDING}",
    );
  });

  it("says the count in the row's metadata line and name", () => {
    // KIN-CONTINUE-007 gave the row one status slot. The row's `aria-label`
    // wins over its subtree, so the count has to be composed into the name
    // too; a name that omitted it would hide the one thing the status exists
    // to say. R-pending-name: the slot names the kind it counts, so all three
    // wordings are pinned — dropping one silently would make a whole kind of
    // wait read as another.
    expect(ROW).toContain(
      'tr("sessions.statusPendingCount", { count: String(pending.approvals) })',
    );
    expect(ROW).toContain(
      'tr("sessions.statusPendingQuestions", { count: String(pending.questions) })',
    );
    expect(ROW).toContain('tr("sessions.pendingApprovals", { count: String(pending.total) })');
    expect(ROW).toContain("data-session-status");
    expect(ROW).toContain("` · ${status}`");
    expect(ROW).toContain("const label = [row.title, agent, at, status");
  });
});
