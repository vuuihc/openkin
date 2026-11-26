import { describe, expect, it } from "@jest/globals";
import { createReadingMemory } from "./readingMemory";

/**
 * KIN-MOBILE-001 §3/§4 离开再回来 — where a conversation was left.
 *
 * The memory is plain functions over a map, so these cases own it directly:
 * no renderer, no layout, no storage. The view's half of the promise (a
 * reopened route scrolls to the stored offset) is
 * `screens/ConversationView.readingReturn.test.tsx`.
 */

describe("KIN-MOBILE-001 §3 leaving and coming back", () => {
  it("KIN-MOBILE-001 §3: an unseen conversation has no reading place", () => {
    const memory = createReadingMemory();

    // Nothing has been read yet, so the view must open on the newest segment
    // rather than inventing an offset.
    expect(memory.read("task-never-opened")).toBeNull();
  });

  it("KIN-MOBILE-001 §3: the last place is read back per conversation", () => {
    const memory = createReadingMemory();

    memory.write("task-a", { offset: 120, pinned: false });

    expect(memory.read("task-a")).toEqual({ offset: 120, pinned: false });
    // A conversation never reads another conversation's place (AGENTS.md §11).
    expect(memory.read("task-b")).toBeNull();

    // Reopening and leaving again moves the place forward; it never keeps the
    // first one.
    memory.write("task-a", { offset: 0, pinned: true });
    expect(memory.read("task-a")).toEqual({ offset: 0, pinned: true });
    expect(memory.read("task-b")).toBeNull();
  });
});
