import { describe, expect, it } from "vitest";
import type { TaskEvent, WorkspaceChange } from "../api/client";
import {
  changedFilesFromDiff,
  countLines,
  extractChangedFiles,
  extractFileDiff,
  lineDeltaFromTool,
  sourceChangesFor,
  summarizeChangedFiles,
} from "./changedFiles";

function toolUse(seq: number, name: string, input: Record<string, unknown>): TaskEvent {
  return {
    task_id: "t1",
    event_epoch: 0,
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

  it("delta for edit_file counts old/new lines", () => {
    expect(
      lineDeltaFromTool("edit_file", {
        path: "a.ts",
        old_string: "old\n",
        new_string: "new\nline\n",
      }),
    ).toEqual({ additions: 2, deletions: 1 });
  });

  it("a delete with no recorded body is unknown, not zero", () => {
    // ±0 would read as "this file changed by nothing" in the chat card, while the
    // workspace bar prints "size unknown" for the same file. Absent is the value the
    // three faces already agree on; zero is a claim the payload did not make.
    expect(lineDeltaFromTool("delete_file", { path: "gone.ts" })).toBeNull();
    expect(lineDeltaFromTool("delete_file", { path: "gone.ts", content: "a\nb\n" })).toEqual({
      additions: 0,
      deletions: 2,
    });
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

  // The label a round evidence card and the workspace list both show. The two
  // families overlap in one direction — `str_replace_editor`, `notebook_edit`
  // and `apply_patch` read like writes and are edits — and the classifier used
  // to answer "write" for every one of them, which is wrong on a card whose
  // whole job is saying what happened.
  it("tells an edit from a write by the tool, not by whether it sounds like one", () => {
    const classified = (name: string) =>
      extractChangedFiles([
        toolUse(1, name, { path: "src/a.ts", old_string: "a", new_string: "b" }),
      ])[0]?.action ?? "none";
    for (const name of [
      "Edit",
      "edit_file",
      "str_replace",
      "str_replace_editor",
      "apply_patch",
      "notebook_edit",
      "file_change",
    ]) {
      expect({ name, action: classified(name) }).toEqual({ name, action: "edit" });
    }
    for (const name of ["Write", "write_file", "create_file"]) {
      expect({ name, action: classified(name) }).toEqual({ name, action: "write" });
    }
    expect(classified("delete_file")).toBe("delete");
  });
});

describe("changedFilesFromDiff", () => {
  const changes: WorkspaceChange[] = [
    { path: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
    { path: "src/b.ts", status: "added" },
    { path: "old/name.ts", old_path: "new/name.ts", status: "renamed" },
    { path: "gone.ts", status: "deleted" },
    { path: "logo.png", status: "binary", binary: true },
  ];

  it("names the workspace a generation's diff belongs to", () => {
    const files = changedFilesFromDiff("ws-1", 7, changes);
    expect(files).toHaveLength(5);
    expect(files[0]).toMatchObject({
      path: "src/a.ts",
      action: "write",
      status: "modified",
      additions: 3,
      deletions: 1,
      workspaceId: "ws-1",
      generation: 7,
    });
    expect(files[2].oldPath).toBe("new/name.ts");
    expect(files[3].action).toBe("delete");
    expect(files[4].binary).toBe(true);
  });

  // A shared checkout has no generation to name, and a row carrying an empty
  // workspace id would read as one that does.
  it("leaves the workspace off a shared checkout's changes", () => {
    const files = changedFilesFromDiff(null, null, changes);
    expect(files).toHaveLength(5);
    expect(files[0].workspaceId).toBeUndefined();
    expect(files[0].generation).toBeUndefined();
    expect(files[0].status).toBe("modified");
  });
});

describe("sourceChangesFor", () => {
  const answer = { taskId: "t2", files: [], truncated: true };

  it("returns the answer that names this task", () => {
    expect(sourceChangesFor(answer, "t2")).toBe(answer);
  });

  // The window between switching tasks and the next answer landing is where a
  // previous task's truncation notice would otherwise be drawn over a list that
  // is not truncated.
  it("refuses an answer that names another task", () => {
    expect(sourceChangesFor(answer, "t1")).toBeNull();
  });

  it("has nothing to return before the first answer", () => {
    expect(sourceChangesFor(null, "t1")).toBeNull();
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

  it("rebuilds edit_file old/new strings", () => {
    const events = [
      toolUse(2, "edit_file", {
        path: "README.md",
        old_string: "before",
        new_string: "after",
      }),
    ];
    const diff = extractFileDiff(events, "README.md");
    expect(diff).not.toBeNull();
    expect(diff!.source).toBe("str_replace");
    expect(diff!.original).toBe("before");
    expect(diff!.modified).toBe("after");
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
