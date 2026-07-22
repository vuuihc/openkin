import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../api/client";
import {
  countLines,
  extractChangedFiles,
  extractFileDiff,
  lineDeltaFromTool,
  summarizeChangedFiles,
} from "./changedFiles";

function toolUse(
  seq: number,
  name: string,
  input: Record<string, unknown>,
): TaskEvent {
  return {
    task_id: "t1",
    seq,
    type: "tool_use",
    ts: seq,
    payload: { name, tool_name: name, input },
  };
}

describe("countLines / lineDeltaFromTool", () => {
  it("counts lines without double-counting trailing newline", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("a\nb\n")).toBe(2);
  });

  it("delta for write_file is all additions", () => {
    expect(
      lineDeltaFromTool("write_file", {
        path: "a.ts",
        content: "line1\nline2\nline3\n",
      }),
    ).toEqual({ additions: 3, deletions: 0 });
  });

  it("delta for str_replace counts old/new lines", () => {
    expect(
      lineDeltaFromTool("str_replace", {
        path: "a.ts",
        old_string: "a\nb\n",
        new_string: "a\nb\nc\nd\n",
      }),
    ).toEqual({ additions: 4, deletions: 2 });
  });

  it("delta for unified patch", () => {
    const patch = [
      "--- a/f",
      "+++ b/f",
      "@@ -1,2 +1,3 @@",
      " context",
      "-old",
      "+new1",
      "+new2",
    ].join("\n");
    expect(lineDeltaFromTool("apply_patch", { path: "f", patch })).toEqual({
      additions: 2,
      deletions: 1,
    });
  });
});

describe("extractChangedFiles stats", () => {
  it("accumulates additions/deletions per path", () => {
    const events = [
      toolUse(1, "write_file", {
        path: "src/a.ts",
        content: "one\ntwo\nthree\n",
      }),
      toolUse(2, "str_replace", {
        path: "src/b.ts",
        old_string: "x\n",
        new_string: "x\ny\nz\n",
      }),
    ];
    const files = extractChangedFiles(events);
    const a = files.find((f) => f.path.includes("a.ts"));
    const b = files.find((f) => f.path.includes("b.ts"));
    expect(a?.additions).toBe(3);
    expect(a?.deletions).toBe(0);
    expect(b?.additions).toBe(3);
    expect(b?.deletions).toBe(1);

    const summary = summarizeChangedFiles(files);
    expect(summary.files).toBe(2);
    expect(summary.hasStats).toBe(true);
    expect(summary.additions).toBe(6);
    expect(summary.deletions).toBe(1);
  });

  it("sums multiple edits on the same file", () => {
    const events = [
      toolUse(1, "str_replace", {
        path: "f.txt",
        old_string: "a",
        new_string: "ab",
      }),
      toolUse(2, "str_replace", {
        path: "f.txt",
        old_string: "ab",
        new_string: "abc",
      }),
    ];
    const files = extractChangedFiles(events);
    expect(files).toHaveLength(1);
    expect(files[0].additions).toBe(2);
    expect(files[0].deletions).toBe(2);
  });

  it("ignores pure reads — only mutations are listed", () => {
    const events = [
      toolUse(1, "read_file", { path: "src/a.ts" }),
      toolUse(2, "write_file", {
        path: "src/b.ts",
        content: "one\n",
      }),
    ];
    const files = extractChangedFiles(events);
    expect(files).toHaveLength(1);
    expect(files[0].path).toContain("b.ts");
    expect(files[0].action).toBe("write");
  });

  it("returns empty when the agent only read files", () => {
    const events = [
      toolUse(1, "read_file", { path: "src/a.ts" }),
      toolUse(2, "read_file", { path: "src/b.ts" }),
    ];
    expect(extractChangedFiles(events)).toEqual([]);
  });

});

describe("extractFileDiff", () => {
  it("rebuilds write_file as empty original + full content", () => {
    const events = [
      toolUse(1, "write_file", {
        path: "src/a.ts",
        content: "export const a = 1;\n",
      }),
    ];
    const diff = extractFileDiff(events, "src/a.ts");
    expect(diff).not.toBeNull();
    expect(diff!.source).toBe("write");
    expect(diff!.original).toBe("");
    expect(diff!.modified).toContain("export const a");
  });

  it("rebuilds str_replace old/new strings", () => {
    const events = [
      toolUse(2, "str_replace", {
        path: "README.md",
        old_string: "hello",
        new_string: "hello world",
      }),
    ];
    const diff = extractFileDiff(events, "README.md");
    expect(diff).not.toBeNull();
    expect(diff!.source).toBe("str_replace");
    expect(diff!.original).toBe("hello");
    expect(diff!.modified).toBe("hello world");
  });

  it("prefers the newest mutation for a path", () => {
    const events = [
      toolUse(1, "write_file", { path: "f.txt", content: "v1" }),
      toolUse(2, "write_file", { path: "f.txt", content: "v2" }),
    ];
    const diff = extractFileDiff(events, "f.txt");
    expect(diff!.modified).toBe("v2");
  });

  it("returns null for read-only tools", () => {
    const events = [toolUse(1, "read_file", { path: "f.txt" })];
    expect(extractFileDiff(events, "f.txt")).toBeNull();
  });
});
