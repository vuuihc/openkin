// KIN-RESULT-003 — a comment points at a diff line, and a tray of them becomes
// one ordinary follow-up message. Pure: no DOM, no Monaco, no network.
import { describe, expect, it } from "vitest";
import {
  anchorForLine,
  commentsStorageKey,
  formatDiffCommentsMessage,
  readDiffComments,
  writeDiffComments,
  type CommentStorage,
  type DiffComment,
  type LineChange,
} from "./diffCommentAnchor";

const CHANGES: LineChange[] = [
  // A replaced block: three original lines become four modified lines.
  {
    originalStartLineNumber: 10,
    originalEndLineNumber: 12,
    modifiedStartLineNumber: 10,
    modifiedEndLineNumber: 13,
  },
  // A pure insertion after line 20: Monaco marks the original side with 0.
  {
    originalStartLineNumber: 20,
    originalEndLineNumber: 0,
    modifiedStartLineNumber: 21,
    modifiedEndLineNumber: 22,
  },
];

function memoryStorage(): CommentStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

function comment(overrides: Partial<DiffComment> = {}): DiffComment {
  return {
    id: "dc_1",
    path: "src/settings.ts",
    hunkHeader: "@@ -10,3 +10,4 @@",
    quote: "const title = settings.title;",
    line: 11,
    text: "This should fall back to the default title.",
    createdAt: 1,
    ...overrides,
  };
}

describe("diff comment anchors", () => {
  it("captures the hunk header and the quoted line for a changed line", () => {
    const anchor = anchorForLine({
      path: "src/settings.ts",
      line: 11,
      lineContent: "const title = settings.title;   ",
      lineChanges: CHANGES,
    });

    expect(anchor).toEqual({
      path: "src/settings.ts",
      hunkHeader: "@@ -10,3 +10,4 @@",
      quote: "const title = settings.title;",
      line: 11,
    });

    // An insertion's header keeps the empty original side as `,0`.
    expect(
      anchorForLine({
        path: "src/settings.ts",
        line: 21,
        lineContent: "  // new",
        lineChanges: CHANGES,
      })?.hunkHeader,
    ).toBe("@@ -20,0 +21,2 @@");

    // A line outside every changed block has no anchor at all.
    expect(
      anchorForLine({ path: "src/settings.ts", line: 14, lineContent: "x", lineChanges: CHANGES }),
    ).toBeNull();
  });

  it("formats one paragraph per comment with path, hunk header and quote", () => {
    const message = formatDiffCommentsMessage([comment()], "Two notes on the diff:");

    expect(message).toBe(
      [
        "Two notes on the diff:",
        "",
        "src/settings.ts:11",
        "@@ -10,3 +10,4 @@",
        "> const title = settings.title;",
        "",
        "This should fall back to the default title.",
      ].join("\n"),
    );
  });

  it("formats a single follow-up message for N comments and keeps the person's words verbatim", () => {
    const message = formatDiffCommentsMessage(
      [
        comment({
          id: "dc_1",
          line: 11,
          text: 'Trim "  both ends  "?\nNo — keep the text as typed.',
        }),
        comment({
          id: "dc_2",
          path: "src/other.ts",
          hunkHeader: "@@ -1,2 +1,2 @@",
          quote: "return a + b;",
          line: 3,
          text: "a + b can overflow here.",
        }),
      ],
      "Two notes on the diff:",
    );

    // One message, a blank line between paragraphs, and the exact same text
    // the person wrote — quotes, newline and all.
    expect(message).toContain(
      'src/settings.ts:11\n@@ -10,3 +10,4 @@\n> const title = settings.title;\n\nTrim "  both ends  "?\nNo — keep the text as typed.',
    );
    expect(message).toContain(
      "src/other.ts:3\n@@ -1,2 +1,2 @@\n> return a + b;\n\na + b can overflow here.",
    );
    expect(message.match(/^Two notes on the diff:$/gm)).toHaveLength(1);
    // One paragraph per comment: two `path:line` headers, each in its own block.
    expect(message.match(/^src\/[a-z]+\.ts:\d+$/gm)).toHaveLength(2);
  });

  it("reads back what was stored for a task and tolerates a corrupt store", () => {
    const storage = memoryStorage();
    const saved = [comment(), comment({ id: "dc_2", line: 21 })];

    writeDiffComments("task-1", saved, storage);
    expect(storage.getItem(commentsStorageKey("task-1"))).toBeTruthy();
    expect(readDiffComments("task-1", storage)).toEqual(saved);

    // The store is keyed by conversation: another task never sees these.
    expect(readDiffComments("task-2", storage)).toEqual([]);

    // Corrupt JSON, a non-array, and a malformed entry all read as `[]`
    // (the malformed entry alone is dropped) instead of crashing the diff.
    storage.setItem(commentsStorageKey("broken-json"), "{not json");
    storage.setItem(commentsStorageKey("not-an-array"), '{"id":"dc_1"}');
    storage.setItem(
      commentsStorageKey("one-bad-entry"),
      JSON.stringify([{ nope: true }, comment({ id: "dc_3" })]),
    );
    expect(readDiffComments("broken-json", storage)).toEqual([]);
    expect(readDiffComments("not-an-array", storage)).toEqual([]);
    expect(readDiffComments("one-bad-entry", storage)).toEqual([comment({ id: "dc_3" })]);

    // No storage at all (a private window, a test) is still an empty tray.
    expect(readDiffComments("task-1", null)).toEqual([]);
  });
});
