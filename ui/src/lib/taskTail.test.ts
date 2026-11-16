import { describe, expect, it } from "vitest";
import type { Task } from "../api/client";
import { mergeTaskTail } from "./taskTail";

/**
 * Reconciling the "load older" tail with the live store.
 *
 * The tail is a page the store does not own: it is fetched once, kept beside
 * the registered list, and never pruned or refreshed. So each row has to be
 * asked back from the store at render time — a deleted row would otherwise
 * 404 when tapped, and a row that finished would stay under the "Running"
 * filter that no longer describes it.
 */

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    agent: "kin",
    cwd: "/tmp",
    prompt: "",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    created_at: 1,
    event_epoch: 0,
    ...overrides,
  };
}

describe("mergeTaskTail", () => {
  it("returns the live page untouched when there is no tail", () => {
    const live = [task("a"), task("b")];
    // Same array, not a copy: the common case is one hundred rows and no
    // second page, and rebuilding that array on every frame is pure waste.
    expect(mergeTaskTail(live, [], () => undefined)).toBe(live);
  });

  it("appends tail rows after the live page", () => {
    const merged = mergeTaskTail([task("a")], [task("b"), task("c")], (id) =>
      id === "b" ? task("b", { status: "running" }) : undefined,
    );
    expect(merged.map((item) => item.id)).toEqual(["a", "b", "c"]);
    // A row the store has never heard of keeps the page's own copy.
    expect(merged[2]).toEqual(task("c"));
  });

  it("drops a tail row the store knows was deleted", () => {
    // `null` is the store's word for "seen, and gone". Keeping the row would
    // render a conversation that opens onto a 404.
    const merged = mergeTaskTail([task("a")], [task("b")], () => null);
    expect(merged.map((item) => item.id)).toEqual(["a"]);
  });

  it("prefers the store's newer copy over the page's stale one", () => {
    // The row was loaded while running and finished since; the tail still
    // says "running". Rendering the tail's copy would leave it under a
    // Running filter it no longer matches.
    const merged = mergeTaskTail([], [task("a", { status: "running" })], () =>
      task("a", { status: "succeeded" }),
    );
    expect(merged[0]!.status).toBe("succeeded");
  });

  it("does not duplicate a row the live page already shows", () => {
    // A live frame can insert a new task at the top of page one, pushing the
    // oldest row of page one into the range the tail covers. Both pages then
    // hold it; it must appear once.
    const merged = mergeTaskTail([task("a"), task("b")], [task("b"), task("c")], () => undefined);
    expect(merged.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps the live page's own order", () => {
    const merged = mergeTaskTail(
      [task("c"), task("b")],
      [task("a")],
      () => undefined,
    );
    expect(merged.map((item) => item.id)).toEqual(["c", "b", "a"]);
  });
});
