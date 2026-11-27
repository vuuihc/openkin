import { describe, expect, it } from "vitest";
import type { Task } from "../api/client";
import { attentionCounts, matchesAttention, normalizeAttentionFilter } from "./sessionAttention";

/**
 * The list's attention view: needs-you and running.
 *
 * The two words are combinations, not statuses. `needs` is the two waiting
 * statuses plus any row that owns a pending approval or question, because the
 * pending item is the authority while a status lags behind it. `running` is
 * every non-terminal state a live turn can be in, so a queued or retrying row
 * does not disappear from the view that promises "what is moving".
 *
 * These are pure rules: the list feeds them its own rows and its own pending
 * map, and they must not learn the cloud buckets' vocabulary — a second copy of
 * "which statuses wait" is exactly how the two views would drift apart.
 */

type Row = Pick<Task, "id" | "status" | "archived_at">;

function row(
  id: string,
  // A status-less imported row is representable at runtime even though the
  // generated `Task` union does not name it; the guard must still answer.
  status: string,
  archivedAt?: number,
): Row {
  return { id, status, archived_at: archivedAt } as Row;
}

const pending = (...ids: string[]) =>
  new Map(ids.map((id) => [id, { approvals: 0, questions: 1, total: 1 }]));

describe("normalizeAttentionFilter", () => {
  it("keeps needs and running and reads anything else as all", () => {
    expect(normalizeAttentionFilter("needs")).toBe("needs");
    expect(normalizeAttentionFilter("running")).toBe("running");
    // A stale link (`?attention=waiting`) must show the whole list, never an
    // empty page that claims nothing is waiting.
    expect(normalizeAttentionFilter(null)).toBe("");
    expect(normalizeAttentionFilter("")).toBe("");
    expect(normalizeAttentionFilter("waiting")).toBe("");
  });
});

describe("matchesAttention", () => {
  it("needs matches waiting_approval, waiting_input and a row with a pending item even before its status flips", () => {
    expect(matchesAttention(row("a", "waiting_approval"), "needs", new Map())).toBe(true);
    expect(matchesAttention(row("b", "waiting_input"), "needs", new Map())).toBe(true);
    // The status still says running; the pending item says someone is blocked.
    expect(matchesAttention(row("c", "running"), "needs", pending("c"))).toBe(true);
    expect(matchesAttention(row("d", "succeeded"), "needs", new Map())).toBe(false);
    expect(matchesAttention(row("e", "running"), "needs", new Map())).toBe(false);
  });

  it("running matches running, queued and retrying but not waiting, terminal or a status-less imported row", () => {
    for (const status of ["running", "queued", "retrying"] as const) {
      expect(matchesAttention(row("a", status), "running", new Map())).toBe(true);
    }
    for (const status of [
      "waiting_approval",
      "waiting_input",
      "succeeded",
      "failed",
      "canceled",
    ] as const) {
      expect(matchesAttention(row("a", status), "running", new Map())).toBe(false);
    }
    // Imported agent sessions carry no status; the view hides them rather than
    // guessing that a status-less row is moving.
    expect(matchesAttention(row("imported", ""), "running", new Map())).toBe(false);
  });

  it("returns every row for the all view", () => {
    expect(matchesAttention(row("a", "succeeded"), "", new Map())).toBe(true);
    expect(matchesAttention(row("b", ""), "", new Map())).toBe(true);
  });
});

describe("attentionCounts", () => {
  it("counts a conversation once when both a pending item and a waiting status point at it", () => {
    const counts = attentionCounts(
      [row("both", "waiting_approval")],
      new Map([["both", { approvals: 0, questions: 3, total: 3 }]]),
    );
    expect(counts).toEqual({ needsYou: 1, running: 0 });
  });

  it("counts only in-flight rows on the live page and ignores archived rows", () => {
    const counts = attentionCounts(
      [
        row("live-waiting", "waiting_input"),
        row("live-running", "running"),
        row("put-away-waiting", "waiting_approval", 99),
        row("put-away-running", "queued", 99),
      ],
      // The pending half is global: an item counts even when its conversation
      // is on an older page. It is one number per conversation.
      new Map([
        ["older-pending", { approvals: 2, questions: 0, total: 2 }],
        ["put-away-pending", { approvals: 0, questions: 1, total: 1 }],
      ]),
    );
    expect(counts).toEqual({ needsYou: 3, running: 1 });
  });
});
