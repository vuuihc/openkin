import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * KIN-CONTINUE-001, steps 2, 3 and 7: the keyboard's way around the Mac shell.
 *
 * The pieces are each tested where they live — `focusSessionSearch` in
 * `sessionSearch.test.ts`, the overlay rule in `overlayOwnsKeyboard.dom.test`,
 * the return row in `rowReturn.test.ts`. What no unit can hold is whether the
 * page actually calls them: ⌘F only beats the conversation's own find when the
 * shell listens in the capture phase and yields to an overlay, Esc only leaves
 * the conversation when the pane is the live one, and the list only lands on
 * the row it came from if both sides remember it. Drop any call and every test
 * above still passes; the Mac keyboard simply goes quiet.
 *
 * Source rather than DOM, like the other page wiring tests: mounting the shell
 * needs a daemon, two live subscriptions and an Electron bridge.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));
const SHELL = readFileSync(join(UI, "src/components/layout/AppShell.tsx"), "utf8");
const TASK = readFileSync(join(UI, "src/pages/TaskDetailPage.tsx"), "utf8");
const SESSIONS = readFileSync(join(UI, "src/pages/SessionsPage.tsx"), "utf8");

describe("the Mac keyboard's wiring", () => {
  it("gives ⌘F to the list before the conversation sees it", () => {
    // Capture phase: the conversation's own handler is on the same key and
    // would open find-in-conversation first. An overlay that owns the keyboard
    // keeps ⌘F away from the list behind it.
    expect(SHELL).toContain('window.addEventListener("keydown", onKey, true)');
    expect(SHELL).toContain("overlayOwnsKeyboard()");
    // Which pane the caret is in, not which pane exists: several are cached.
    // The helper's answer has to gate the fallthrough, or ⌘F is taken from the
    // transcript it was pressed in and handed to the list behind it.
    expect(SHELL).toContain("if (focusInsideConversationPane()) return;");
    expect(SHELL).toContain("focusSessionSearch()");
  });

  it("lets Esc leave the live conversation for the list search", () => {
    // Only the pane on screen answers: a hidden conversation's Esc must not
    // pull focus out of the one being read.
    expect(TASK).toContain("if (!active || !wide) return;");
    // The order is the rule: an overlay that already took the key wins, and
    // the move happens after dispatch so the palette and find bar can claim
    // the event on their own timers.
    expect(TASK).toContain(
      "if (overlayOwnsKeyboard()) return;\n      window.setTimeout(() => {\n        if (event.defaultPrevented) return;\n        focusSessionSearch();",
    );
  });

  it("brings the list back to the row the conversation was opened from", () => {
    expect(SESSIONS).toContain("rememberRowReturn(row.task?.id ?? row.session!.id)");
    expect(SESSIONS).toContain("takeRowReturn()");
    // The mark is consumed when it lands; a later keystroke in the search must
    // not pull the caret back onto the row.
    expect(SESSIONS).toContain("setReturnRow(consumeRowReturn(returnRow))");
  });
});
