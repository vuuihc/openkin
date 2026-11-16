// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  forgetLastConversation,
  lastConversation,
  rememberLastConversation,
} from "./lastConversation";

/**
 * KIN-CONTINUE-001, step 1: opening the app shows the conversation that was
 * last on screen. Keep-alive covers switching inside the app; this stored id is
 * what survives a quit.
 */

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("the resume point", () => {
  it("remembers the conversation that was open", () => {
    rememberLastConversation("task-1");
    expect(lastConversation()).toBe("task-1");
    rememberLastConversation("task-2");
    expect(lastConversation()).toBe("task-2");
  });

  it("has no opinion on a first run", () => {
    expect(lastConversation()).toBeNull();
  });

  it("forgets a deleted conversation but not a newer one", () => {
    rememberLastConversation("task-1");
    // A slower 404 for an older task must not erase the conversation the
    // reader has since opened.
    forgetLastConversation("task-old");
    expect(lastConversation()).toBe("task-1");
    forgetLastConversation("task-1");
    expect(lastConversation()).toBeNull();
    forgetLastConversation();
    expect(lastConversation()).toBeNull();
  });

  it("keeps working when storage refuses to write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => rememberLastConversation("task-1")).not.toThrow();
    expect(lastConversation()).toBeNull();
  });
});
