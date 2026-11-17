// KIN-RESULT-003 — a comment points at a diff line, and a tray of them becomes
// one ordinary follow-up message. Pure: no DOM, no Monaco, no network.
import { describe, expect, it } from "vitest";
import {
  anchorForLine,
  commentsStorageKey,
  formatDiffCommentsMessage,
  reanchorComments,
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

/** A file of `count` lines with the given 1-based entries; the rest are blank. */
function linesWith(entries: Record<number, string>, count: number): string[] {
  const lines = Array.from({ length: count }, () => "");
  for (const [line, text] of Object.entries(entries)) lines[Number(line) - 1] = text;
  return lines;
}

function block(
  originalStart: number,
  originalEnd: number,
  modifiedStart: number,
  modifiedEnd: number,
): LineChange {
  return {
    originalStartLineNumber: originalStart,
    originalEndLineNumber: originalEnd,
    modifiedStartLineNumber: modifiedStart,
    modifiedEndLineNumber: modifiedEnd,
  };
}

/**
 * KIN-RESULT-003 part 2 — the saved anchor is matched against a fresh diff.
 * The answer is a function of (anchor, lineChanges, lines) only: the tray can
 * render it without Monaco, and storage is never rewritten.
 */
describe("re-anchoring (KIN-RESULT-003 part 2)", () => {
  it("re-places a comment on the same quoted line after its hunk moved", () => {
    // The block moved from modified 10-13 to 40-42 and the quoted line now
    // sits at 41. The quote is the identity; the saved line number is not.
    const results = reanchorComments([comment()], {
      path: "src/settings.ts",
      lineChanges: [block(30, 32, 40, 42)],
      lines: linesWith({ 41: "const title = settings.title;   " }, 60),
    });

    expect(results).toEqual([{ id: "dc_1", line: 41, stale: false }]);
  });

  it("reports a stale anchor and keeps the saved line when the quoted line is gone", () => {
    const results = reanchorComments([comment()], {
      path: "src/settings.ts",
      lineChanges: [block(10, 12, 10, 13)],
      lines: linesWith({ 11: "const title = settings.fallbackTitle;" }, 30),
    });

    // The saved line stays so the row remains jumpable; the state says stale.
    expect(results).toEqual([{ id: "dc_1", line: 11, stale: true }]);
  });

  it("does not attach a stale comment to a neighbouring changed line", () => {
    const results = reanchorComments([comment()], {
      path: "src/settings.ts",
      lineChanges: [block(10, 12, 10, 13), block(20, 20, 21, 22)],
      lines: linesWith(
        {
          10: "const title = settings.title + '!';",
          12: "const title = settings.title; // moved?",
          21: "const title = settings.title + suffix;",
        },
        30,
      ),
    });

    // Line 12 is one line away and 21 is ten, but neither carries the exact
    // quoted text — only the saved line itself could be the match, and it is
    // not.
    expect(results).toEqual([{ id: "dc_1", line: 11, stale: true }]);
  });

  it("prefers the saved hunk header when the same quote appears in two hunks", () => {
    const saved = comment({ line: 13, hunkHeader: "@@ -10,3 +10,4 @@" });
    const results = reanchorComments([saved], {
      path: "src/settings.ts",
      lineChanges: [
        // The saved block, unchanged numbers, quote now on its first line.
        block(10, 12, 10, 13),
        // A new block right after it with the same quoted text, one line
        // closer to the saved line than the saved block's match.
        block(20, 21, 14, 15),
      ],
      lines: linesWith(
        { 10: "const title = settings.title;", 14: "const title = settings.title;" },
        30,
      ),
    });

    // Distance alone would pick 14; the saved hunk header wins.
    expect(results).toEqual([{ id: "dc_1", line: 10, stale: false }]);
  });

  it("re-points a stale comment when its quoted line comes back", () => {
    const changes = [block(10, 12, 10, 13)];
    const gone = reanchorComments([comment()], {
      path: "src/settings.ts",
      lineChanges: changes,
      lines: linesWith({ 11: "const title = settings.fallbackTitle;" }, 30),
    });
    expect(gone).toEqual([{ id: "dc_1", line: 11, stale: true }]);

    // No stored "stale" bit: the same saved comment re-points with no
    // migration once the line exists again.
    const back = reanchorComments([comment()], {
      path: "src/settings.ts",
      lineChanges: [block(30, 32, 40, 42)],
      lines: linesWith({ 41: "const title = settings.title;" }, 60),
    });
    expect(back).toEqual([{ id: "dc_1", line: 41, stale: false }]);
  });

  it("returns no answer for another file or a diff that is not computed yet", () => {
    const input = {
      lineChanges: [block(10, 12, 10, 13)],
      lines: linesWith({ 11: "const title = settings.title;" }, 30),
    };

    // Another file's comments are none of this diff's business.
    expect(reanchorComments([comment()], { ...input, path: "src/other.ts" })).toEqual([]);
    // No computed diff is not "everything is stale" — it is no answer at all.
    expect(
      reanchorComments([comment()], { ...input, path: "src/settings.ts", lineChanges: null }),
    ).toEqual([]);
    expect(
      reanchorComments([comment()], { ...input, path: "src/settings.ts", lineChanges: [] }),
    ).toEqual([]);
  });
});
