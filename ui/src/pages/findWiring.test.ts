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
 * from the row's own handler and the sheet's cleanup returns focus to the
 * opener after the bar has focused its field, leaving a focused-looking input
 * that never raises a keyboard. Neither failure shows up anywhere else.
 *
 * Source rather than DOM, like `sessionSearchWiring.test.ts`: mounting this
 * page needs a daemon, a machine list and two live subscriptions.
 *
 * KIN-CONTINUE-001: an overlay must not leave the conversation's shortcuts
 * live behind it, so the panel and file-finder cases here stay red if the gate
 * is loosened.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE = readFileSync(join(UI, "src/pages/TaskDetailPage.tsx"), "utf8");
const ACTION_SHEET = readFileSync(join(UI, "src/components/ui/ActionSheet.tsx"), "utf8");

describe("the phone's way into find-in-conversation", () => {
  it("offers the row in the session sheet", () => {
    expect(SOURCE).toContain('tr("chat.find.menu")');
  });

  it("opens the bar after the action sheet has released its history entry", () => {
    // The row asks the page to show Find. ActionSheet owns the timing: it keeps
    // the row action pending until its own history entry, focus trap and
    // surface have gone. The real BrowserRouter case is in
    // TaskDetailPage.pushContract.dom.test.tsx.
    expect(SOURCE).toContain("onSelect: () => setFindOpen(true)");
    expect(ACTION_SHEET).toContain("pending.current = row.onSelect");
    expect(ACTION_SHEET).toContain("onCloseComplete");
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
    // The conversation's j/k/a/d gate is document-wide now: the permission
    // menu and the run-config layers are `menu`/`listbox` roles portaled over
    // the same pane, which no ancestor selector can see.
    expect(SOURCE).toContain("overlayOwnsKeyboard()");
  });

  it("opens on the words a chat search sent, in the pane in front only", () => {
    // The palette navigates with `?find=…`; the page reads it and ChatStream
    // seeds the bar with it. The panes behind the tab strip are mounted too,
    // and each would open a bar nobody can see. The hook also consumes the
    // parameter, so picking the same hit again is not a no-op. It must wait for
    // the task detail: the conversation is not mounted while the page shows its
    // skeleton, and a seed consumed then would be deleted before it could be
    // handed over.
    expect(SOURCE).toContain("const findSeed = useFindSeed(active && !loading);");
    expect(SOURCE).toContain("findSeed={findSeed}");
  });
});
