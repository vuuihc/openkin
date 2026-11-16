import type { Approval, TaskEvent } from "../api/client";

/**
 * The card the console holds for an event that is waiting on the user.
 *
 * Answering it is a request, so the card is the console's to build. What travels
 * with the anchor is this: which request it answers, so the card can be matched
 * to the transcript position it was asked at.
 */
export type PendingRef = { kind: "approval" | "question"; id: string };

/** One card waiting on the user, and where in the conversation it was asked. */
export type PendingEntry = {
  kind: PendingRef["kind"];
  id: string;
  /** Seq of the event that asked, when it is still in the loaded window. */
  seq: number | null;
};

/**
 * Reading order, which is also keyboard order.
 *
 * `j` / `k` walk this list, so it has to be the order the eye walks the
 * transcript: by the event each card was asked at, oldest first. A card whose
 * event has scrolled out of the loaded window has no place in the conversation
 * to sit at — it is rendered at the end of the stream — so it sorts last. Two
 * cards with no anchor keep the order the server listed them in rather than
 * swapping on every render.
 */
export function orderPending<T extends PendingEntry>(entries: T[]): T[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const left = a.entry.seq;
      const right = b.entry.seq;
      if (left === null && right === null) return a.index - b.index;
      if (left === null) return 1;
      if (right === null) return -1;
      return left - right;
    })
    .map(({ entry }) => entry);
}

/** The cards that have a place in the conversation, keyed for the stream. */
export function anchoredPendingIds<T extends PendingEntry>(entries: T[]): Set<string> {
  const anchored = new Set<string>();
  for (const entry of entries) {
    if (entry.seq !== null) anchored.add(entry.id);
  }
  return anchored;
}

type ApprovalEvent = { event: TaskEvent; payload: Record<string, unknown> };

function approvalEvents(events: TaskEvent[]): {
  requested: Map<string, ApprovalEvent>;
  decided: Map<string, ApprovalEvent>;
} {
  const requested = new Map<string, ApprovalEvent>();
  const decided = new Map<string, ApprovalEvent>();
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const id = typeof payload.approval_id === "string" ? payload.approval_id : "";
    if (!id) continue;
    if (event.type === "approval_requested") requested.set(id, { event, payload });
    else if (event.type === "approval_decided") decided.set(id, { event, payload });
  }
  return { requested, decided };
}

function decisionOf(value: unknown): Approval["decision"] | null {
  return value === "approved" || value === "denied" || value === "expired"
    ? (value as Approval["decision"])
    : null;
}

/**
 * The answers already in the transcript, rebuilt as approvals.
 *
 * The pending list only carries what is still waiting, so a conversation
 * reloaded after a decision — or watched from another device — used to show
 * the request and no outcome. The event stream has both halves: the request
 * carries the tool body, the decision carries what was chosen. Joined by
 * `approval_id`, they describe the same card the reader answered on the other
 * device, which is the point ("the same result, not a second pending card").
 */
export function decidedApprovalsFromEvents(events: TaskEvent[]): Approval[] {
  const { requested, decided } = approvalEvents(events);
  const out: Approval[] = [];
  for (const [id, answer] of decided) {
    const ask = requested.get(id);
    if (!ask) continue;
    const decision = decisionOf(answer.payload.decision);
    if (!decision) continue;
    const decidedAt = Number(answer.payload.decided_at);
    const via = answer.payload.decided_via;
    out.push({
      id,
      task_id: ask.event.task_id,
      kind: typeof ask.payload.kind === "string" ? ask.payload.kind : "",
      payload: ask.payload.payload ?? {},
      decision,
      created_at: Number.isFinite(Number(ask.event.ts)) ? Number(ask.event.ts) : 0,
      ...(typeof via === "string" && via ? { decided_via: via } : {}),
      decided_at:
        Number.isFinite(decidedAt) && decidedAt > 0
          ? decidedAt
          : Number(answer.event.ts) || undefined,
    });
  }
  return out;
}

/**
 * The decided cards a pane should draw: the answers the stream remembers, plus
 * the ones this pane just gave (which the stream has not delivered yet).
 *
 * A locally retained answer wins over its event copy: it is the full row the
 * daemon returned, including a decision timestamp the event's version may lack.
 * Anything the live approval list still returns is dropped here — that list is
 * the authority while it lists the row, and drawing both would be two cards for
 * one decision.
 */
export function mergeDecidedApprovals(
  live: readonly Approval[],
  retained: Record<string, Approval>,
  events: TaskEvent[],
): Approval[] {
  const byId = new Map<string, Approval>();
  for (const approval of decidedApprovalsFromEvents(events)) byId.set(approval.id, approval);
  for (const [id, approval] of Object.entries(retained)) byId.set(id, approval);
  const liveIds = new Set(live.map((approval) => approval.id));
  return [...byId.values()]
    .filter((approval) => approval.decision !== "pending" && !liveIds.has(approval.id))
    .sort((a, b) => a.created_at - b.created_at);
}
