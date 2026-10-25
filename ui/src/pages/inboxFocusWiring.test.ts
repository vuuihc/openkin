import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The inbox landing, as source.
 *
 * Source rather than DOM, like `phoneKeyboardHints.test.ts` and
 * `PhoneSection.test.ts`: the tree has no DOM test environment by design, and
 * the effects that do the landing can only be reasoned about. What *is* checkable
 * is the wiring — that the resolved focus reaches both card types, that the
 * scroll is the one-shot kind, and that a link naming nothing is explained
 * rather than silently ignored. Each of those is one deleted line away from
 * failing quietly.
 */
const UI = fileURLToPath(new URL("../..", import.meta.url));

const page = readFileSync(join(UI, "src/pages/ApprovalsPage.tsx"), "utf8");

describe("the inbox deep-link landing", () => {
  it("resolves the id against both lists", () => {
    expect(page).toMatch(/resolveInboxFocus\(focusId, items, questions\)/);
  });

  it("rings the named card, whichever kind it is", () => {
    expect(page).toMatch(/focused=\{approvalsKeyboardLive && i === focusIdx\}/);
    expect(page).toMatch(/const questionFocusId = !cursorTakenOver/);
    expect(page).toMatch(/focused=\{q\.id === questionFocusId\}/);
  });

  it("rings exactly one card: taking the cursor moves the ring off the question", () => {
    // Measured in a browser before this line existed: `?focus=<qid>` then `j`
    // drew the question *and* the first approval with the "focused" badge.
    expect(page).not.toMatch(/focused=\{focus\.kind === "question" && q\.id === focus\.id\}/);
  });

  it("scrolls to it once per id", () => {
    // Once: a live update or a keystroke must not yank the page back while
    // someone is reading it. A bare `scrollIntoView` in a render-path effect
    // would.
    expect(page).toMatch(/scrolledFor\.current === hitId/);
    expect(page).toMatch(/el\.scrollIntoView\(\{ block: "center" \}\)/);
    expect(page).toMatch(/if \(a\.id === hitId\) hitRef\.current = node;/);
    expect(page).toMatch(/ref=\{q\.id === hitId \? hitRef : undefined\}/);
  });

  it("explains an id that names nothing, unless this page spent it", () => {
    expect(page).toMatch(/data-testid="inbox-focus-missing"/);
    // Answering the notification is the normal end of it; saying "that one is
    // not waiting any more" to the person who just handled it is not.
    expect(page).toMatch(/!handledHere\.current\.has\(focus\.id\)/);
  });

  it("keeps the keyboard decision out of the listener", () => {
    // The parked state (a link that named a question) is what the listener got
    // wrong once: it disabled `j`/`k` along with `a`/`d`. `inboxKeyboard.ts`
    // holds the transition and its own tests, and the listener has to *apply*
    // the returned state — a page that reads only the index leaves the ring and
    // the keyboard disagreeing.
    expect(page).toMatch(/inboxKeyOutcome\(e\.key, items,/);
    expect(page).toMatch(/setCursorTakenOver\(action\.state\.cursorTakenOver\)/);
    expect(page).toMatch(/setFocusIdx\(action\.state\.focusIdx\)/);
    expect(page).not.toMatch(/e\.key === "j"/);
  });

  it("clamps the ring when the list shrinks under it", () => {
    // Deciding an approval removes it from `items`. Without this the index
    // outlives its card, and the invariant "a decision lands on the ring" stops
    // being true by construction.
    expect(page).toMatch(/Math\.min\(i, Math\.max\(0, items\.length - 1\)\)/);
  });
});
