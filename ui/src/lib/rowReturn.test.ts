// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeRowReturn,
  focusRowFor,
  rememberRowReturn,
  takeRowReturn,
} from "./rowReturn";

/**
 * KIN-CONTINUE-001, step 7: coming back to the list lands on the row the
 * conversation was opened from, not at the top of the page.
 */

beforeEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the list's return row", () => {
  it("hands the row from the conversation screen to the list once", () => {
    rememberRowReturn("task-1");
    expect(takeRowReturn()).toBe("task-1");
    // A second list render has nothing to restore and must not steal focus.
    expect(takeRowReturn()).toBeNull();
  });

  it("has nothing to restore for a cold open", () => {
    expect(takeRowReturn()).toBeNull();
  });

  it("focuses the row when it is on screen and says when it is not", () => {
    const list = document.createElement("div");
    list.innerHTML = '<button type="button" data-session-row="task-1">one</button>';
    document.body.appendChild(list);
    expect(focusRowFor("task-2")).toBe(false);
    expect(focusRowFor("task-1")).toBe(true);
    expect(document.activeElement?.getAttribute("data-session-row")).toBe("task-1");
  });
});

// The list re-renders on every keystroke in its search and on every live
// update. A mark that survived its first successful focus would pull the caret
// back out of the field the reader had just tapped.
describe("consuming the return row", () => {
  it("keeps the mark until the row is on screen", () => {
    expect(consumeRowReturn("task-1")).toBe("task-1");
    expect(document.activeElement).toBe(document.body);
  });

  it("returns nothing once the row has been focused", () => {
    const list = document.createElement("div");
    list.innerHTML = '<button type="button" data-session-row="task-1">one</button>';
    document.body.appendChild(list);

    expect(consumeRowReturn("task-1")).toBeNull();
    expect(document.activeElement?.getAttribute("data-session-row")).toBe("task-1");
  });

  it("does not steal focus on a later render after it was consumed", () => {
    const list = document.createElement("div");
    list.innerHTML = '<input /><button type="button" data-session-row="task-1">one</button>';
    document.body.appendChild(list);
    consumeRowReturn("task-1");

    const field = document.querySelector("input")!;
    field.focus();
    // The next render still sees the row, but the mark is gone: the reader's
    // later click into the field wins.
    expect(consumeRowReturn(null)).toBeNull();
    expect(document.activeElement).toBe(field);
  });
});
