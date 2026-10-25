import { beforeEach, describe, expect, it } from "vitest";
import { SHELL_VIEW } from "../lib/panels";
import { useAppStore } from "./appStore";

/**
 * The four actions that hold the panel and lens state.
 *
 * `lib/panels.ts` and `lib/workspaceLens.ts` are tested as pure functions, and
 * this is the layer above them: the store is where "one surface, one writer" is
 * actually enforced for the running app, and it had no test — so a `togglePanel`
 * that never closed, a `hidePanel` that did nothing, or a `pickWorkspaceLens`
 * that dropped the view all passed the suite. Each action is checked against the
 * rule its own doc comment states, not against the helper it happens to call.
 */

const store = () => useAppStore.getState();

beforeEach(() => {
  useAppStore.setState({ shownPanel: null, lensPick: null });
});

describe("shownPanel actions", () => {
  it("toggles the panel a view asked for, and keeps at most one", () => {
    store().togglePanel("task-1", "files");
    expect(store().shownPanel).toEqual({ view: "task-1", id: "files" });
    // A different view's panel replaces it rather than joining it: one surface,
    // which is the invariant the shape exists to hold.
    store().togglePanel(SHELL_VIEW, "terminal");
    expect(store().shownPanel).toEqual({ view: SHELL_VIEW, id: "terminal" });
    // Asking for the one that is already open closes it.
    store().togglePanel(SHELL_VIEW, "terminal");
    expect(store().shownPanel).toBeNull();
  });

  it("opens without toggling, which is what clicking a changed file needs", () => {
    store().showPanel("task-1", "files");
    store().showPanel("task-1", "files");
    expect(store().shownPanel).toEqual({ view: "task-1", id: "files" });
  });

  it("closes only the view in front, and is free for a view with nothing open", () => {
    store().showPanel("task-1", "files");
    store().hidePanel("task-2");
    expect(store().shownPanel).toEqual({ view: "task-1", id: "files" });
    store().hidePanel("task-1");
    expect(store().shownPanel).toBeNull();
    // Closing what is already closed leaves the value alone rather than throwing
    // or inventing an entry.
    store().hidePanel("task-1");
    expect(store().shownPanel).toBeNull();
  });
});

describe("pickWorkspaceLens", () => {
  it("remembers the lens with the place it was picked in", () => {
    store().pickWorkspaceLens("task-1", "generation:w1", "files");
    expect(store().lensPick).toEqual({ taskId: "task-1", view: "generation:w1", lens: "files" });
    // The view is part of the identity, not decoration: it is what forgets a
    // manual pick when the session moves to another generation.
    store().pickWorkspaceLens("task-1", "source", "changes");
    expect(store().lensPick).toEqual({ taskId: "task-1", view: "source", lens: "changes" });
  });
});
