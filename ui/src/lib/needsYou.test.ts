import { describe, expect, it } from "vitest";
import type { Approval, TaskEvent } from "../api/client";
import {
  anchoredPendingIds,
  decidedApprovalsFromEvents,
  mergeDecidedApprovals,
  orderPending,
  type PendingEntry,
} from "./needsYou";

function entry(
  id: string,
  seq: number | null,
  kind: PendingEntry["kind"] = "approval",
): PendingEntry {
  return { kind, id, seq };
}

describe("orderPending", () => {
  it("walks the transcript, not the order the server listed them in", () => {
    const ordered = orderPending([entry("c", 40), entry("a", 12), entry("b", 30)]);

    expect(ordered.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("puts the cards with no anchor last, in the order they came in", () => {
    // No anchor means the asking event scrolled out of the loaded window, so the
    // card is painted at the end of the stream. Keyboard order has to agree with
    // where the eye finds it, or `j` jumps somewhere the user cannot see.
    const ordered = orderPending([
      entry("later", 50),
      entry("orphan-1", null),
      entry("orphan-2", null),
    ]);

    expect(ordered.map((e) => e.id)).toEqual(["later", "orphan-1", "orphan-2"]);
  });

  it("keeps approvals and questions on one axis", () => {
    // They are answered in different cards but they block the same turn, so the
    // user walks them in the order the agent asked.
    const ordered = orderPending([entry("q2", 20, "question"), entry("a1", 5), entry("a2", 11)]);

    expect(ordered.map((e) => e.id)).toEqual(["a1", "a2", "q2"]);
  });

  it("has nothing to order for no cards", () => {
    expect(orderPending([])).toEqual([]);
  });
});

describe("anchoredPendingIds", () => {
  it("separates the cards that have a place in the conversation", () => {
    const anchored = anchoredPendingIds([entry("in-window", 7), entry("scrolled-out", null)]);

    expect([...anchored]).toEqual(["in-window"]);
  });
});

// KIN-CONTINUE-001, step 6: the answer survives the reload, and reaches the
// other device. The pending list only holds what is still waiting, so a card
// that was answered on the phone has to be rebuilt from the transcript's own
// request + decision pair — the same card, saying what was decided.
function event(
  type: string,
  seq: number,
  payload: Record<string, unknown>,
  ts = 1_700_000_000_000,
): TaskEvent {
  return { task_id: "task-1", event_epoch: 0, seq, ts, type, payload } as TaskEvent;
}

const asked = event("approval_requested", 1, {
  approval_id: "a1",
  kind: "tool",
  payload: { tool: "Bash", input: { command: "rm -rf build" } },
});
const answered = event("approval_decided", 2, {
  approval_id: "a1",
  decision: "approved",
  decided_via: "web",
  decided_at: 1_700_000_005_000,
});

function approved(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "a1",
    task_id: "task-1",
    kind: "tool",
    payload: { tool: "Bash", input: { command: "rm -rf build" } },
    decision: "approved",
    created_at: 1_700_000_000_000,
    decided_via: "web",
    decided_at: 1_700_000_005_000,
    ...overrides,
  } as Approval;
}

describe("decided approvals from the transcript", () => {
  it("rebuilds the card and the answer from the two events", () => {
    const [card] = decidedApprovalsFromEvents([asked, answered]);

    expect(card).toMatchObject({
      id: "a1",
      task_id: "task-1",
      kind: "tool",
      decision: "approved",
      decided_via: "web",
      decided_at: 1_700_000_005_000,
      created_at: 1_700_000_000_000,
    });
    expect(card!.payload).toEqual({ tool: "Bash", input: { command: "rm -rf build" } });
  });

  it("needs the request: a decision alone has no card to draw", () => {
    // The asking event can be older than the loaded window; a card without its
    // tool body would be an empty box, so it is left out rather than faked.
    expect(decidedApprovalsFromEvents([answered])).toEqual([]);
  });

  it("ignores a decision value it does not know", () => {
    const weird = event("approval_decided", 2, { approval_id: "a1", decision: "maybe" });
    expect(decidedApprovalsFromEvents([asked, weird])).toEqual([]);
  });

  it("prefers the answer this pane just gave over the event copy", () => {
    const local = approved({ decided_at: 1_700_000_009_999 });
    const cards = mergeDecidedApprovals([], { a1: local }, [asked, answered]);

    expect(cards).toHaveLength(1);
    expect(cards[0]).toBe(local);
  });

  it("drops the card while the live list still returns the same approval", () => {
    expect(mergeDecidedApprovals([approved()], { a1: approved() }, [asked, answered])).toEqual([]);
  });

  it("orders the reconstructed cards the way they were asked", () => {
    const second = event(
      "approval_requested",
      3,
      {
        approval_id: "a2",
        kind: "tool",
        payload: { tool: "Read" },
      },
      1_700_000_002_000,
    );
    const secondAnswer = event(
      "approval_decided",
      4,
      {
        approval_id: "a2",
        decision: "denied",
        decided_via: "timeout",
      },
      1_700_000_003_000,
    );

    const cards = mergeDecidedApprovals([], {}, [asked, answered, second, secondAnswer]);
    expect(cards.map((card) => card.id)).toEqual(["a1", "a2"]);
    expect(cards[1]!.decided_at).toBe(1_700_000_003_000);
  });
});
