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
    // One definition of "the approvals answer to keys", imported rather than
    // re-derived: the page's own copy of this rule was a line no test could
    // reach, and `armed = true` survived a full mutation sweep.
    expect(page).toMatch(/const approvalsKeyboardLive = inboxKeyboardArmed\(keyState\)/);
    expect(page).toMatch(
      /const questionFocusId = approvalsKeyboardLive \? null : parkedQuestionId/,
    );
    expect(page).toMatch(/focused=\{q\.id === questionFocusId\}/);
  });

  it("rings exactly one card: taking the cursor moves the ring off the question", () => {
    // Measured in a browser before this line existed: `?focus=<qid>` then `j`
    // drew the question *and* the first approval with the "focused" badge. The
    // two expressions above are what make that impossible; this only catches a
    // reintroduction of the literal.
    expect(page).not.toMatch(/focused=\{focus\.kind === "question" && q\.id === focus\.id\}/);
  });

  it("scrolls to it once per id", () => {
    // Once: a live update or a keystroke must not yank the page back while
    // someone is reading it. A bare `scrollIntoView` in a render-path effect
    // would.
    expect(page).toMatch(/scrolledFor\.current === hitId/);
    expect(page).toMatch(/el\.scrollIntoView\(\{ block: "center" \}\)/);
    expect(page).toMatch(/if \(a\.id === hitId\) hitRef\.current = node;/);
    expect(page).toMatch(/if \(q\.id === hitId\) hitRef\.current = node;/);
  });

  it("brings the ring into view when a press moves it", () => {
    // Taking over or walking back can ring a card off-screen in either
    // direction; without this the headline behaviour of `j` and `k` looked like
    // a key that did nothing.
    expect(page).toMatch(/if \(action\.moved !== "cursor"\)/);
    expect(page).toMatch(/rowRefs\.current\.get\(id\)\?\.scrollIntoView\(\{ block: "nearest" \}\)/);
    expect(page).toMatch(/action\.moved === "returned"/);
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
    expect(page).toMatch(/inboxKeyOutcome\(e\.key, items, keyState\)/);
    expect(page).toMatch(/setCursorTakenOver\(action\.state\.cursorTakenOver\)/);
    expect(page).toMatch(/setFocusIdx\(action\.state\.focusIdx\)/);
    expect(page).not.toMatch(/e\.key === "j"/);
  });

  it("parking starts again on a new link", () => {
    // The takeover belongs to the link it interrupted; without the reset a `j`
    // on one deep link leaves the next question un-ringed on arrival.
    expect(page).toMatch(/useEffect\(\(\) => setCursorTakenOver\(false\), \[focusId\]\)/);
  });

  it("clamps the ring when the list shrinks under it", () => {
    // Deciding an approval removes it from `items`. Without this the index
    // outlives its card, and the invariant "a decision lands on the ring" stops
    // being true by construction. The dependency is asserted too: an effect that
    // only ran on mount would be the same bug with extra steps.
    expect(page).toMatch(/Math\.min\(i, Math\.max\(0, items\.length - 1\)\)/);
    expect(page).toMatch(/\}, \[items\.length\]\);/);
  });
});
