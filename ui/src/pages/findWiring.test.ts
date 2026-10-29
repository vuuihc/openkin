import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The phone's way into find-in-conversation, which no unit can hold.
 *
 * The bar's own behaviour is covered in `ChatStream.find.dom.test.tsx`, and the
 * matching in `findInTranscript.test.ts`. What is left is the wiring: the sheet
 * row that opens it and the order in which the two surfaces take focus. Drop
 * the row and the phone has no find at all (no Cmd+F on a phone); open the bar
 * from the row's own handler and Ionic, which keeps keyboard focus inside the
 * action sheet until it is removed, leaves a focused-looking field that never
 * raises a keyboard. Neither failure shows up anywhere else.
 *
 * Source rather than DOM, like `sessionSearchWiring.test.ts`: mounting this
 * page needs a daemon, a machine list and two live subscriptions.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE = readFileSync(join(UI, "src/pages/TaskDetailPage.tsx"), "utf8");

describe("the phone's way into find-in-conversation", () => {
  it("offers the row in the session sheet", () => {
    expect(SOURCE).toContain('tr("chat.find.menu")');
  });

  it("opens the bar on dismissal, not on the tap", () => {
    // The row leaves a note; the sheet's `onDidDismiss` reads it. Calling
    // `setFindOpen(true)` in the row's handler would focus the field while the
    // overlay still owns focus.
    expect(SOURCE).toContain("openFindAfterSheet.current = true");
    expect(SOURCE).toContain("openFindAfterSheet.current = false");
  });

  it("lets only an uncovered active pane claim the shortcut", () => {
    // Sessions stay mounted behind the tab strip, so a pane that is not the
    // active one must not claim Cmd+F. A panel is not a second pane either: it
    // is a full-surface overlay, so while one is open the conversation's bar is
    // behind it — the shortcut took focus into a field the reader cannot see
    // and sent their typing there. The file finder is a third layer over the
    // same page, and while it is up the bar is behind it too. Monaco keeps its
    // own find; everything else falls through to the browser.
    expect(SOURCE).toContain("findShortcut={active && panel === null && !fileFinderOpen}");
  });
});
