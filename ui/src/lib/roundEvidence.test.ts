import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../api/client";
import {
  evidenceFilePreview,
  recordedRoundEvidence,
  recordedRounds,
  roundEvidence,
  ROUND_EVIDENCE_MAX_FILES,
} from "./roundEvidence";

function toolUse(seq: number, name: string, input: Record<string, unknown>): TaskEvent {
  return {
    task_id: "t1",
    event_epoch: 1,
    seq,
    type: "tool_use",
    ts: seq,
    payload: { name, tool_name: name, input },
  };
}

function message(seq: number, role: string, text: string): TaskEvent {
  return {
    task_id: "t1",
    event_epoch: 1,
    seq,
    type: "message",
    ts: seq,
    payload: { role, text },
  };
}

describe("roundEvidence", () => {
  it("reads the files a round changed through file tools", () => {
    const events = [
      message(1, "user", "add a helper"),
      toolUse(2, "read_file", { path: "src/a.ts" }),
      toolUse(3, "write_file", { path: "src/b.ts", content: "export const b = 1;\n" }),
      toolUse(4, "edit_file", {
        path: "src/a.ts",
        old_string: "const a = 1;",
        new_string: "const a = 2;",
      }),
      message(5, "assistant", "done"),
    ];
    const evidence = roundEvidence(events, { fromSeq: 1, toSeq: 5 });
    expect(evidence).not.toBeNull();
    expect(evidence!.files.map((file) => file.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(evidence!.totalFiles).toBe(2);
    // A read is not a change, and the file it read is not in the list.
    expect(evidence!.files.some((file) => file.action === "read")).toBe(false);
    expect(evidence!.hasStats).toBe(true);
    expect(evidence!.additions).toBe(2);
    expect(evidence!.deletions).toBe(1);
  });

  it("shows nothing for a round nothing carried a seq for", () => {
    const events = [toolUse(1, "write_file", { path: "src/a.ts", content: "x\n" })];
    expect(roundEvidence(events, {})).toBeNull();
    expect(roundEvidence(events, { fromSeq: 1 })).toBeNull();
    expect(roundEvidence(events, { toSeq: 1 })).toBeNull();
  });

  it("shows nothing for a round that only talked", () => {
    const events = [message(1, "user", "what does this do?"), message(2, "assistant", "this")];
    expect(roundEvidence(events, { fromSeq: 1, toSeq: 2 })).toBeNull();
  });

  it("keeps a round's own events apart from the round next to it", () => {
    const events = [
      toolUse(1, "write_file", { path: "src/a.ts", content: "first\n" }),
      message(2, "user", "again"),
      toolUse(3, "write_file", { path: "src/b.ts", content: "second\n" }),
    ];
    const first = roundEvidence(events, { fromSeq: 1, toSeq: 2 });
    expect(first!.files.map((file) => file.path)).toEqual(["src/a.ts"]);
    const second = roundEvidence(events, { fromSeq: 2, toSeq: 3 });
    expect(second!.files.map((file) => file.path)).toEqual(["src/b.ts"]);
  });

  it("caps the list it hands the card and counts what it left out", () => {
    const events = Array.from({ length: ROUND_EVIDENCE_MAX_FILES + 2 }, (_, i) =>
      toolUse(i + 1, "write_file", { path: `src/f${i}.ts`, content: `// ${i}\n` }),
    );
    const evidence = roundEvidence(events, { fromSeq: 1, toSeq: events.length });
    expect(evidence!.files).toHaveLength(ROUND_EVIDENCE_MAX_FILES);
    expect(evidence!.totalFiles).toBe(ROUND_EVIDENCE_MAX_FILES + 2);
    // The counts are the round's, not the capped list's.
    expect(evidence!.additions).toBe(ROUND_EVIDENCE_MAX_FILES + 2);
  });

  it("does not confirm a shell command as a changed file", () => {
    const events = [
      toolUse(1, "bash", { command: "sed -i '' 's/a/b/' src/a.ts" }),
      message(2, "assistant", "rewrote it with sed"),
    ];
    expect(roundEvidence(events, { fromSeq: 1, toSeq: 2 })).toBeNull();
  });
});

describe("evidenceFilePreview", () => {
  it("draws the last change to a file in the round", () => {
    const events = [
      toolUse(1, "edit_file", {
        path: "src/a.ts",
        old_string: "const a = 1;",
        new_string: "const a = 2;",
      }),
      toolUse(2, "edit_file", {
        path: "src/a.ts",
        old_string: "const a = 2;",
        new_string: "const a = 3;",
      }),
    ];
    const evidence = roundEvidence(events, { fromSeq: 1, toSeq: 2 })!;
    const preview = evidenceFilePreview(evidence, "src/a.ts");
    expect(preview!.lines.map((line) => `${line.type}:${line.text}`)).toEqual([
      "del:const a = 2;",
      "add:const a = 3;",
    ]);
  });

  it("says nothing for a file whose payload is not a change", () => {
    const events = [
      toolUse(1, "delete_file", { path: "src/gone.ts" }),
      toolUse(2, "write_file", { path: "src/a.ts", content: "x\n" }),
    ];
    const evidence = roundEvidence(events, { fromSeq: 1, toSeq: 2 })!;
    expect(evidence.files.map((file) => file.path).sort()).toEqual(["src/a.ts", "src/gone.ts"]);
    expect(evidenceFilePreview(evidence, "src/gone.ts")).toBeNull();
    expect(evidenceFilePreview(evidence, "src/never-touched.ts")).toBeNull();
  });

  it("reads a patch payload as its own before and after", () => {
    const patch = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " keep",
      "-old",
      "+new",
      " tail",
    ].join("\n");
    const events = [toolUse(1, "apply_patch", { patch })];
    const evidence = roundEvidence(events, { fromSeq: 1, toSeq: 1 })!;
    const preview = evidenceFilePreview(evidence, "src/a.ts", { context: 1 });
    expect(preview!.lines.map((line) => `${line.type}:${line.text}`)).toEqual([
      "ctx:keep",
      "del:old",
      "add:new",
      "ctx:tail",
    ]);
  });
});

describe("recordedRounds", () => {
  it("reads the files of a round the daemon recorded", () => {
    const events: TaskEvent[] = [
      message(1, "user", "rename it"),
      {
        task_id: "t1",
        event_epoch: 1,
        seq: 6,
        type: "round_changed",
        ts: 6,
        payload: {
          from_seq: 1,
          to_seq: 5,
          total: 2,
          files: [
            { path: "internal/parse.go", status: "modified", additions: 3, deletions: 1 },
            { path: "internal/renamed.go", status: "added", additions: 9 },
          ],
        },
      },
    ];
    const recorded = recordedRounds(events);
    expect([...recorded.keys()]).toEqual([1]);
    expect(recorded.get(1)!.map((change) => change.path)).toEqual([
      "internal/parse.go",
      "internal/renamed.go",
    ]);
    expect(recorded.get(1)![0]).toEqual({
      path: "internal/parse.go",
      status: "modified",
      additions: 3,
      deletions: 1,
    });
  });

  it("ignores a record with no round to key it to", () => {
    const events: TaskEvent[] = [
      {
        task_id: "t1",
        event_epoch: 1,
        seq: 3,
        type: "round_changed",
        ts: 3,
        payload: { files: [] },
      },
      {
        task_id: "t1",
        event_epoch: 1,
        seq: 4,
        type: "round_changed",
        ts: 4,
        payload: { from_seq: 2, files: [{ status: "modified" }] },
      },
    ];
    const recorded = recordedRounds(events);
    // The first has no round to key it to; the second is a round that changed
    // nothing, and the malformed file inside it is dropped rather than drawn.
    expect([...recorded.keys()]).toEqual([2]);
    expect(recorded.get(2)).toEqual([]);
  });

  it("keeps the newest record for a round", () => {
    // A retried turn rewrites the record for the round before it; the reader is
    // looking at the rewritten timeline.
    const record = (seq: number, path: string): TaskEvent => ({
      task_id: "t1",
      event_epoch: 1,
      seq,
      type: "round_changed",
      ts: seq,
      payload: { from_seq: 1, files: [{ path, status: "modified" }] },
    });
    const recorded = recordedRounds([record(3, "old.go"), record(9, "new.go")]);
    expect(recorded.get(1)!.map((change) => change.path)).toEqual(["new.go"]);
  });
});

describe("recordedRoundEvidence", () => {
  it("is null for a round that changed nothing", () => {
    expect(recordedRoundEvidence([], [])).toBeNull();
    expect(recordedRoundEvidence(undefined, [])).toBeNull();
  });

  it("says the list came from the workspace", () => {
    const evidence = recordedRoundEvidence(
      [{ path: "src/a.ts", status: "modified", additions: 2, deletions: 1 }],
      [],
    )!;
    expect(evidence.source).toBe("workspace");
    expect(evidence.totalFiles).toBe(1);
    expect(evidence.additions).toBe(2);
    expect(evidence.hasStats).toBe(true);
    expect(evidenceFilePreview(evidence, "src/a.ts")).toBeNull();
  });

  it("keeps the payload preview for a file the record also lists", () => {
    const events = [
      toolUse(2, "write_file", { path: "src/b.ts", content: "export const b = 1;\n" }),
    ];
    const evidence = recordedRoundEvidence(
      [
        { path: "src/b.ts", status: "added", additions: 1 },
        { path: "src/sed.ts", status: "modified", additions: 1, deletions: 1 },
      ],
      events,
    )!;
    expect(evidenceFilePreview(evidence, "src/b.ts")).not.toBeNull();
    // The shell edit has no payload behind it; the row still exists.
    expect(evidenceFilePreview(evidence, "src/sed.ts")).toBeNull();
  });
});
