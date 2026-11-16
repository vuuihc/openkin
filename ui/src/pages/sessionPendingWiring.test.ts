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
    expect(SOURCE).toContain("pendingCount={row.task ? (pendingByTask.get(row.task.id) ?? 0) : 0}");
  });

  it("draws the chip and says the count in the row's name", () => {
    // The badge's own label sits inside the button, and the row's `aria-label`
    // wins over that subtree: a name that omitted the count would hide the one
    // thing the orange mark exists to say.
    expect(ROW).toContain("<PendingBadge count={pendingCount} />");
    expect(ROW).toContain('tr("sessions.pendingApprovals", { count: String(pendingCount) })');
  });
});
