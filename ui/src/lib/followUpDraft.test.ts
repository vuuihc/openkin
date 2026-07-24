import { beforeEach, describe, expect, it, vi } from "vitest";

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
  key: (index: number) => Array.from(store.keys())[index] ?? null,
  get length() {
    return store.size;
  },
};

vi.stubGlobal("localStorage", localStorageMock);

const {
  clearFollowUpDraft,
  getFollowUpDraft,
  setFollowUpDraft,
} = await import("./followUpDraft");

describe("followUpDraft", () => {
  beforeEach(() => {
    store.clear();
  });

  it("returns empty draft when nothing stored", () => {
    expect(getFollowUpDraft("task-1")).toEqual({
      prompt: "",
      attachments: [],
      updatedAt: 0,
    });
  });

  it("stores and restores prompt + attachments per task", () => {
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

    setFollowUpDraft("task-a", {
      prompt: "follow up please",
      attachments,
    });
    setFollowUpDraft("task-b", { prompt: "other task" });

    const a = getFollowUpDraft("task-a");
    expect(a.prompt).toBe("follow up please");
    expect(a.attachments).toEqual(attachments);
    expect(a.updatedAt).toBeGreaterThan(0);

    expect(getFollowUpDraft("task-b").prompt).toBe("other task");
    expect(getFollowUpDraft("task-b").attachments).toEqual([]);
  });

  it("does not leak drafts across tasks", () => {
    setFollowUpDraft("task-1", { prompt: "one" });
    expect(getFollowUpDraft("task-2").prompt).toBe("");
  });

  it("clears draft when prompt and attachments become empty", () => {
    setFollowUpDraft("task-1", { prompt: "keep me" });
    expect(store.has("kin_followup_draft:task-1")).toBe(true);

    setFollowUpDraft("task-1", { prompt: "   ", attachments: [] });
    expect(store.has("kin_followup_draft:task-1")).toBe(false);
    expect(getFollowUpDraft("task-1").prompt).toBe("");
  });

  it("clearFollowUpDraft removes the key", () => {
    setFollowUpDraft("task-1", { prompt: "x" });
    clearFollowUpDraft("task-1");
    expect(getFollowUpDraft("task-1").prompt).toBe("");
  });

  it("ignores malformed stored JSON", () => {
    store.set("kin_followup_draft:task-1", "{not-json");
    expect(getFollowUpDraft("task-1")).toEqual({
      prompt: "",
      attachments: [],
      updatedAt: 0,
    });
  });

  it("filters incomplete attachments", () => {
    store.set(
      "kin_followup_draft:task-1",
      JSON.stringify({
        prompt: "hi",
        attachments: [{ id: "incomplete" }, {
          id: "ok.txt",
          name: "ok.txt",
          mime: "text/plain",
          size: 1,
          url: "/api/uploads/ok.txt",
          path: "/tmp/ok.txt",
        }],
        updatedAt: 1,
      }),
    );
    const d = getFollowUpDraft("task-1");
    expect(d.prompt).toBe("hi");
    expect(d.attachments).toHaveLength(1);
    expect(d.attachments[0]?.id).toBe("ok.txt");
  });

  it("prunes old entries beyond the cap", () => {
    const now = Date.now();
    for (let i = 0; i < 45; i++) {
      store.set(
        `kin_followup_draft:old-${i}`,
        JSON.stringify({
          prompt: `p${i}`,
          attachments: [],
          updatedAt: now - (45 - i) * 1000,
        }),
      );
    }
    setFollowUpDraft("fresh", { prompt: "newest" });
    expect(getFollowUpDraft("fresh").prompt).toBe("newest");
    // Cap is 40; writing triggers prune of the oldest extras.
    const remaining = Array.from(store.keys()).filter((k) =>
      k.startsWith("kin_followup_draft:"),
    );
    expect(remaining.length).toBeLessThanOrEqual(40);
    expect(store.has("kin_followup_draft:fresh")).toBe(true);
  });
});
