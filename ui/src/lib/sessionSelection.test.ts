import { describe, expect, it } from "vitest";
import type { Task } from "../api/client";
import type { PhoneProjectBucket, PhoneSessionRow } from "./phoneSessionBuckets";
import { rowSelectable, selectableTaskIds } from "./sessionSelection";

function task(id: string, archived = false): Task {
  return {
    id,
    title: id,
    agent: "kin",
    cwd: "/work/alpha",
    prompt: "",
    status: "succeeded",
    tokens_in: 0,
    tokens_out: 0,
    created_at: 1,
    event_epoch: 0,
    ...(archived ? { archived_at: 9 } : {}),
  };
}

function row(id: string, archived = false): PhoneSessionRow {
  return { key: id, at: 1, title: id, agentId: "kin", remote: false, task: task(id, archived) };
}

function imported(id: string): PhoneSessionRow {
  return {
    key: id,
    at: 1,
    title: id,
    agentId: "claude",
    remote: false,
    session: { id } as unknown as PhoneSessionRow["session"],
  };
}

function bucket(rows: PhoneSessionRow[]): PhoneProjectBucket {
  return { key: "/work/alpha", label: "alpha", rows, lastActivityAt: 1 };
}

describe("rowSelectable", () => {
  it("selects any conversation in the live list", () => {
    expect(rowSelectable(row("live"), "active")).toBe(true);
    expect(rowSelectable(row("away", true), "active")).toBe(true);
  });

  it("selects only a put-away conversation in the archive view", () => {
    // The archive view also lists the chats of an archived project. Restore
    // there would write a no-op and report success.
    expect(rowSelectable(row("away", true), "archived")).toBe(true);
    expect(rowSelectable(row("project-chat"), "archived")).toBe(false);
  });

  it("never selects an imported agent session", () => {
    // It has no task id, so there is nothing for a batch to act on.
    expect(rowSelectable(imported("s1"), "active")).toBe(false);
    expect(rowSelectable(imported("s1"), "archived")).toBe(false);
  });
});

describe("selectableTaskIds", () => {
  it("answers every selectable id across buckets, in list order", () => {
    const buckets = [
      bucket([row("a"), row("b", true), imported("s")]),
      bucket([row("c")]),
    ];
    expect(selectableTaskIds(buckets, "active")).toEqual(["a", "b", "c"]);
  });

  it("narrows to put-away conversations in the archive view", () => {
    // The select-all checkbox and the selected count read the same list: a
    // count that included the project's live chats would say "3 selected"
    // while only one row could be restored.
    const buckets = [bucket([row("away", true), row("project-chat")])];
    expect(selectableTaskIds(buckets, "archived")).toEqual(["away"]);
  });
});
