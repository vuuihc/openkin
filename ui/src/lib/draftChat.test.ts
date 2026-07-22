import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();

const localStorageMock = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => {
    store.set(key, value);
  },
  removeItem: (key: string) => {
    store.delete(key);
  },
  clear: () => store.clear(),
};

// Minimal EventTarget so CustomEvent fan-out works in node vitest.
class MiniTarget {
  private listeners = new Map<string, Set<EventListener>>();
  addEventListener(type: string, fn: EventListener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: EventListener) {
    this.listeners.get(type)?.delete(fn);
  }
  dispatchEvent(event: { type: string }) {
    for (const fn of this.listeners.get(event.type) ?? []) {
      fn(event as Event);
    }
    return true;
  }
}

const win = new MiniTarget();
vi.stubGlobal("localStorage", localStorageMock);
vi.stubGlobal("window", win);
vi.stubGlobal(
  "CustomEvent",
  class CustomEvent {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  },
);

const {
  clearDraftPrompt,
  getDraftAttachments,
  getDraftPrompt,
  setDraftAttachments,
  setDraftPrompt,
  subscribeDraft,
} = await import("./draftChat");

describe("draftChat prompt persistence", () => {
  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    clearDraftPrompt();
    setDraftAttachments([]);
  });

  it("stores and restores unsent prompt text", () => {
    setDraftPrompt("hello draft");
    expect(getDraftPrompt()).toBe("hello draft");
  });

  it("clears prompt when empty string is set", () => {
    setDraftPrompt("keep me");
    setDraftPrompt("");
    expect(getDraftPrompt()).toBe("");
  });

  it("notifies subscribers on prompt change", () => {
    const fn = vi.fn();
    const unsub = subscribeDraft(fn);
    setDraftPrompt("ping");
    expect(fn).toHaveBeenCalled();
    unsub();
  });

  it("stores and restores uploaded attachments", () => {
    const attachments = [
      {
        id: "upload-1.png",
        name: "diagram.png",
        mime: "image/png",
        size: 1234,
        url: "/api/uploads/upload-1.png",
        path: "/tmp/kin/uploads/upload-1.png",
      },
    ];

    setDraftAttachments(attachments);

    expect(getDraftAttachments()).toEqual(attachments);
  });

  it("ignores malformed stored attachments", () => {
    store.set("kin_draft_attachments", JSON.stringify([{ id: "incomplete" }]));
    expect(getDraftAttachments()).toEqual([]);
  });

  it("clears stored attachments when the list becomes empty", () => {
    setDraftAttachments([
      {
        id: "upload-1.txt",
        name: "notes.txt",
        mime: "text/plain",
        size: 42,
        url: "/api/uploads/upload-1.txt",
        path: "/tmp/kin/uploads/upload-1.txt",
      },
    ]);
    setDraftAttachments([]);
    expect(getDraftAttachments()).toEqual([]);
  });
});
