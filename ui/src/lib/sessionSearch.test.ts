// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { focusInsideConversationPane, focusSessionSearch } from "./sessionSearch";

/**
 * KIN-CONTINUE-001, step 2: one keystroke lands in the window's only list
 * search.
 *
 * The shortcut and the overlay gate live in `AppShell`; this is the move they
 * make when the shell says "the list has the keyboard". Focus goes to the
 * field with its text selected, so typing replaces the old word the way ⌘F
 * does everywhere else.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

describe("focusSessionSearch", () => {
  it("focuses the search field and selects what is already in it", () => {
    document.body.innerHTML =
      '<input data-session-search type="search" value="alpha" aria-label="Search" />';
    const field = document.querySelector<HTMLInputElement>("[data-session-search]")!;

    expect(focusSessionSearch()).toBe(true);
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 5]);
  });

  it("says when the window has no list on screen", () => {
    expect(focusSessionSearch()).toBe(false);
  });
});

describe("focusInsideConversationPane", () => {
  it("answers about the pane holding the caret, not the first pane in the document", () => {
    // Several cached panes are mounted at once and the hidden ones come first.
    // Asking the document for "the" pane answered about a hidden transcript,
    // so Cmd+F inside a visible one was taken by the list search.
    document.body.innerHTML = `
      <div data-conversation-pane><input id="hidden" /></div>
      <div data-conversation-pane><input id="visible" /></div>
    `;
    const visible = document.querySelector<HTMLInputElement>("#visible")!;
    visible.focus();
    expect(focusInsideConversationPane()).toBe(true);
  });

  it("says the caret is outside when no transcript holds it", () => {
    document.body.innerHTML = '<input id="search" /><div data-conversation-pane></div>';
    document.querySelector<HTMLInputElement>("#search")!.focus();
    expect(focusInsideConversationPane()).toBe(false);
  });
});
