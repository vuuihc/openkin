import { describe, expect, it, jest } from "@jest/globals";
import type { Approval, UserQuestion } from "@ui/api/contract";
import {
  answerQuestionPath,
  approvalDecisionPath,
  createApprovals,
  entriesForTask,
  pendingApprovalsPath,
  pendingQuestionsPath,
  type ApprovalsModel,
  type PendingEntry,
} from "./approvalsModel";

/**
 * KIN-MOBILE-001 R5 — the approvals/questions headless core.
 *
 * These are the signed R5 acceptance rows (approve -> waiting -> handled with
 * the count dropping by one; failure restores the card with a reason; offline
 * blocks submit but keeps what was read) plus the two rules every async answer
 * in this client carries: a response for a replaced list is dropped
 * (AGENTS.md §11) and every wait has a bound (§13).
 *
 * The model returns stable reason codes and records, never sentences: R5b maps
 * them to the shared i18n catalogue.
 */

const ORIGIN = "https://kin.example.com";
const TOKEN = "fixture-token-not-real";

function approval(id: string, createdAt = 1): Approval {
  return {
    id,
    task_id: "task-1",
    kind: "tool_use",
    payload: { tool_name: "Bash", input: { command: "ls" } },
    decision: "pending",
    created_at: createdAt,
  };
}

function question(id: string, createdAt = 2): UserQuestion {
  return {
    id,
    task_id: "task-1",
    payload: { question: "Proceed?", options: [] },
    status: "pending",
    created_at: createdAt,
  };
}

type Call = { url: string; init: RequestInit };

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Records every request and answers through the test's own router. */
function recordingFetch(
  reply: (url: string) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = jest.fn(async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init: init ?? {} });
    return reply(input);
  });
  return { fetchImpl: impl as unknown as typeof fetch, calls };
}

/** The two pending-list reads the model starts; anything else is unexpected. */
function listRouter(
  approvals: Approval[],
  questions: UserQuestion[],
  extra?: (url: string) => Response | Promise<Response> | undefined,
) {
  return recordingFetch((url) => {
    const special = extra?.(url);
    if (special !== undefined) return special;
    if (url === ORIGIN + pendingApprovalsPath) return jsonResponse(200, approvals);
    if (url === ORIGIN + pendingQuestionsPath) return jsonResponse(200, questions);
    throw new Error(`unexpected request: ${url}`);
  });
}

function modelWith(
  fetchImpl: typeof fetch,
  timeoutMs?: number,
): ApprovalsModel {
  return createApprovals({
    origin: ORIGIN,
    token: TOKEN,
    fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

function entryOf(model: ApprovalsModel, id: string): PendingEntry {
  const found = model.getState().items.find((item) => item.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
}

describe("KIN-MOBILE-001 R5 approvals and questions", () => {
  it("KIN-MOBILE-001 R5: load reads the same pending endpoints as the web console", async () => {
    const { fetchImpl, calls } = listRouter(
      [approval("a1", 10), approval("a2", 20)],
      [question("q1")],
    );
    const model = modelWith(fetchImpl);

    expect(model.getState().status).toBe("idle");
    await model.load();

    expect(calls.map((call) => call.url).sort()).toEqual(
      [ORIGIN + pendingApprovalsPath, ORIGIN + pendingQuestionsPath].sort(),
    );
    expect(calls.every((call) => call.init.method === "GET")).toBe(true);
    expect(
      (calls[0].init.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${TOKEN}`);

    const state = model.getState();
    expect(state.status).toBe("ready");
    expect(state.pendingCount).toBe(3);
    expect(state.items.map((item) => item.id)).toEqual(["a2", "a1", "q1"]);
    expect(entryOf(model, "a1").phase).toBe("idle");
    expect(entryOf(model, "q1").kind).toBe("question");
  });

  it("KIN-MOBILE-001 R5: approve moves a card idle -> submitting -> resolved and drops the count by one", async () => {
    const decision = deferred<Response>();
    const { fetchImpl, calls } = listRouter(
      [approval("a1"), approval("a2", 0)],
      [question("q1")],
      (url) =>
        url === ORIGIN + approvalDecisionPath("a1") ? decision.promise : undefined,
    );
    const model = modelWith(fetchImpl);
    await model.load();
    expect(model.getState().pendingCount).toBe(3);

    const pending = model.approve("a1");
    expect(entryOf(model, "a1").phase).toBe("submitting");

    decision.resolve(
      jsonResponse(200, {
        ...approval("a1"),
        decision: "approved",
        decided_via: "ios:ios-fixture",
      }),
    );
    await expect(pending).resolves.toMatchObject({ ok: true });

    const state = model.getState();
    const decided = entryOf(model, "a1");
    expect(decided.phase).toBe("resolved");
    expect(decided.pending).toBe(false);
    expect(decided.kind).toBe("approval");
    if (decided.kind === "approval") {
      expect(decided.approval.decision).toBe("approved");
      expect(decided.resolution).toEqual({
        kind: "approval",
        decision: "approved",
      });
    }
    expect(state.pendingCount).toBe(2);
    // The handled card stays visible with its one-line result.
    expect(state.items).toHaveLength(3);

    const posted = calls.find((call) => call.url === ORIGIN + approvalDecisionPath("a1"));
    expect(posted?.init.method).toBe("POST");
    expect(posted?.init.body).toBe(JSON.stringify({ decision: "approved" }));
  });

  it("KIN-MOBILE-001 R5: a failed decision restores the card with its reason and keeps the count", async () => {
    const { fetchImpl } = listRouter(
      [approval("a1")],
      [],
      (url) =>
        url === ORIGIN + approvalDecisionPath("a1")
          ? jsonResponse(409, { error: "already decided" })
          : undefined,
    );
    const model = modelWith(fetchImpl);
    await model.load();
    expect(model.getState().pendingCount).toBe(1);

    const result = await model.deny("a1");

    expect(result).toMatchObject({ ok: false, reason: "rejected" });
    const state = model.getState();
    const card = entryOf(model, "a1");
    expect(card.phase).toBe("idle");
    expect(card.pending).toBe(true);
    expect(card.failure).toEqual({ reason: "rejected", status: 409 });
    expect(card.resolution).toBeUndefined();
    expect(state.pendingCount).toBe(1);
  });

  it("KIN-MOBILE-001 R5: offline blocks submit and keeps the items already read", async () => {
    const { fetchImpl, calls } = listRouter([approval("a1")], [question("q1")]);
    const model = modelWith(fetchImpl);
    await model.load();
    model.setOnline(false);

    const result = await model.approve("a1");

    expect(result).toEqual({ ok: false, reason: "offline" });
    expect(calls.some((call) => call.url.includes("/decision"))).toBe(false);
    const state = model.getState();
    expect(state.online).toBe(false);
    expect(state.items).toHaveLength(2);
    expect(state.pendingCount).toBe(2);
    expect(entryOf(model, "a1").phase).toBe("idle");
  });

  it("KIN-MOBILE-001 R5: a second submit while submitting sends one request", async () => {
    const decision = deferred<Response>();
    const { fetchImpl, calls } = listRouter(
      [approval("a1")],
      [],
      (url) =>
        url === ORIGIN + approvalDecisionPath("a1") ? decision.promise : undefined,
    );
    const model = modelWith(fetchImpl);
    await model.load();

    const first = model.approve("a1");
    const second = model.approve("a1");
    await expect(second).resolves.toEqual({ ok: false, reason: "busy" });

    decision.resolve(jsonResponse(200, { ...approval("a1"), decision: "approved" }));
    await expect(first).resolves.toMatchObject({ ok: true });

    const decisions = calls.filter(
      (call) => call.url === ORIGIN + approvalDecisionPath("a1"),
    );
    expect(decisions).toHaveLength(1);
    expect(model.getState().pendingCount).toBe(0);
  });

  it("KIN-MOBILE-001 R5: a late answer for a replaced list is dropped", async () => {
    const decision = deferred<Response>();
    let round = 0;
    const { fetchImpl } = listRouter(
      [],
      [],
      (url) => {
        if (url === ORIGIN + pendingApprovalsPath) {
          round += 1;
          // The reload reports a1 still pending: the decision has not landed.
          return jsonResponse(200, [approval("a1")]);
        }
        if (url === ORIGIN + pendingQuestionsPath) return jsonResponse(200, []);
        if (url === ORIGIN + approvalDecisionPath("a1")) return decision.promise;
        return undefined;
      },
    );
    const model = modelWith(fetchImpl);
    await model.load();
    const firstRevision = model.getState().revision;

    const late = model.approve("a1");
    // The screen moved on: a new list replaces the one the card belonged to.
    await model.load();
    expect(model.getState().revision).toBeGreaterThan(firstRevision);

    decision.resolve(jsonResponse(200, { ...approval("a1"), decision: "approved" }));

    await expect(late).resolves.toEqual({ ok: false, reason: "stale" });
    const state = model.getState();
    // The replacement list wins: the card is actionable again, count untouched.
    expect(entryOf(model, "a1").phase).toBe("idle");
    expect(entryOf(model, "a1").resolution).toBeUndefined();
    expect(state.pendingCount).toBe(1);
    expect(round).toBe(2);
  });

  it("KIN-MOBILE-001 R5: a reload makes its card actionable before the superseded decision settles", async () => {
    const superseded = deferred<Response>();
    const posts: string[] = [];
    let rounds = 0;
    const { fetchImpl } = listRouter(
      [],
      [],
      (url) => {
        if (url === ORIGIN + pendingApprovalsPath) {
          rounds += 1;
          return jsonResponse(200, [approval("a1")]);
        }
        if (url === ORIGIN + pendingQuestionsPath) return jsonResponse(200, []);
        if (url === ORIGIN + approvalDecisionPath("a1")) {
          posts.push(url);
          return posts.length === 1
            ? superseded.promise
            : jsonResponse(200, { ...approval("a1"), decision: "approved" });
        }
        return undefined;
      },
    );
    const model = modelWith(fetchImpl);
    await model.load();

    const first = model.approve("a1");
    expect(entryOf(model, "a1").phase).toBe("submitting");

    // The screen reloads while the superseded decision is still on the wire.
    // The replacement card is idle, not blocked as `busy` by the older request.
    await model.load();
    expect(entryOf(model, "a1").phase).toBe("idle");

    const second = model.approve("a1");
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(posts).toHaveLength(2);
    expect(entryOf(model, "a1").phase).toBe("resolved");

    // The superseded request settles late; its answer belongs to the old list.
    superseded.resolve(
      jsonResponse(200, { ...approval("a1"), decision: "approved" }),
    );
    await expect(first).resolves.toEqual({ ok: false, reason: "stale" });
    expect(entryOf(model, "a1").phase).toBe("resolved");
    expect(model.getState().pendingCount).toBe(0);
    expect(rounds).toBe(2);
  });

  it("KIN-MOBILE-001 R5: a stale list read keeps a card decided while it was on the wire", async () => {
    const stale = deferred<Response>();
    let rounds = 0;
    const { fetchImpl } = listRouter(
      [],
      [],
      (url) => {
        if (url === ORIGIN + pendingApprovalsPath) {
          rounds += 1;
          // The second read is the snapshot taken before the decision.
          return rounds === 1 ? jsonResponse(200, [approval("a1")]) : stale.promise;
        }
        if (url === ORIGIN + pendingQuestionsPath) return jsonResponse(200, []);
        if (url === ORIGIN + approvalDecisionPath("a1")) {
          return jsonResponse(200, { ...approval("a1"), decision: "approved" });
        }
        return undefined;
      },
    );
    const model = modelWith(fetchImpl);
    await model.load();

    // A reload starts first; the decision lands while its GET is on the wire.
    const refreshing = model.load();
    await expect(model.approve("a1")).resolves.toMatchObject({ ok: true });
    expect(entryOf(model, "a1").phase).toBe("resolved");
    expect(model.getState().pendingCount).toBe(0);

    // The older snapshot still lists a1 as pending: it must not re-pend the
    // card or restore the count.
    stale.resolve(jsonResponse(200, [approval("a1")]));
    await refreshing;

    const card = entryOf(model, "a1");
    expect(card.phase).toBe("resolved");
    expect(card.pending).toBe(false);
    expect(card.resolution).toEqual({ kind: "approval", decision: "approved" });
    expect(model.getState().pendingCount).toBe(0);
  });

  it("KIN-MOBILE-001 R5: answering a question resolves it with the answer and drops the count", async () => {
    const { fetchImpl, calls } = listRouter(
      [],
      [question("q1")],
      (url) =>
        url === ORIGIN + answerQuestionPath("q1")
          ? jsonResponse(200, {
              ...question("q1"),
              status: "answered",
              response: { selected: [], other_text: "Because the tests pass" },
            })
          : undefined,
    );
    const model = modelWith(fetchImpl);
    await model.load();
    expect(model.getState().pendingCount).toBe(1);

    const result = await model.answer("q1", "Because the tests pass");

    expect(result).toMatchObject({ ok: true });
    const answered = entryOf(model, "q1");
    expect(answered.phase).toBe("resolved");
    expect(answered.pending).toBe(false);
    expect(answered.resolution).toEqual({
      kind: "question",
      text: "Because the tests pass",
    });
    if (answered.kind === "question") {
      expect(answered.question.status).toBe("answered");
    }
    expect(model.getState().pendingCount).toBe(0);

    const posted = calls.find((call) => call.url === ORIGIN + answerQuestionPath("q1"));
    expect(posted?.init.method).toBe("POST");
    expect(posted?.init.body).toBe(
      JSON.stringify({ selected: [], other_text: "Because the tests pass" }),
    );
  });

  it("KIN-MOBILE-001 R5: a stalled decision hits the bound instead of hanging", async () => {
    const fetchImpl = jest.fn((input: string, init?: RequestInit) => {
      if (input === ORIGIN + pendingApprovalsPath) {
        return Promise.resolve(jsonResponse(200, [approval("a1")]));
      }
      if (input === ORIGIN + pendingQuestionsPath) {
        return Promise.resolve(jsonResponse(200, []));
      }
      // The decision request connects and never answers until it is aborted.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    }) as unknown as typeof fetch;
    const model = modelWith(fetchImpl, 20);
    await model.load();

    const result = await model.approve("a1");

    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
    const card = entryOf(model, "a1");
    expect(card.phase).toBe("idle");
    expect(card.failure).toEqual({ reason: "unreachable", status: null });
    expect(model.getState().pendingCount).toBe(1);
  });

  it("KIN-MOBILE-001 R5: entriesForTask keeps only the cards this conversation asked for", async () => {
    // Two approvals and one question on the node; only some belong to task-1.
    const { fetchImpl } = listRouter(
      [
        { ...approval("a1", 20), task_id: "task-1" },
        { ...approval("a2", 10), task_id: "task-2" },
      ],
      [{ ...question("q1", 30), task_id: "task-1" }],
    );
    const model = modelWith(fetchImpl);
    await model.load();
    const whole = model.getState();
    expect(whole.items.map((item) => item.id)).toEqual(["a1", "a2", "q1"]);
    expect(whole.pendingCount).toBe(3);

    const scoped = entriesForTask(whole, "task-1");

    expect(scoped.items.map((item) => item.id)).toEqual(["a1", "q1"]);
    expect(scoped.pendingCount).toBe(2);
    // Every other field is the model's own: this is a view, not a new list.
    expect(scoped.status).toBe(whole.status);
    expect(scoped.online).toBe(whole.online);
    expect(scoped.error).toBe(whole.error);
    expect(scoped.revision).toBe(whole.revision);

    expect(entriesForTask(whole, "task-2").items.map((item) => item.id)).toEqual(["a2"]);
    expect(entriesForTask(whole, "task-2").pendingCount).toBe(1);
    const stranger = entriesForTask(whole, "task-unknown");
    expect(stranger.items).toEqual([]);
    expect(stranger.pendingCount).toBe(0);
  });

  it("KIN-MOBILE-001 R5: entriesForTask leaves the model's own list untouched", async () => {
    const { fetchImpl } = listRouter(
      [
        { ...approval("a1", 20), task_id: "task-1" },
        { ...approval("a2", 10), task_id: "task-2" },
      ],
      [],
      (url) =>
        url === ORIGIN + approvalDecisionPath("a1")
          ? jsonResponse(200, { ...approval("a1"), decision: "approved" })
          : undefined,
    );
    const model = modelWith(fetchImpl);
    await model.load();
    model.setOnline(false);
    const whole = model.getState();
    const originalItems = whole.items;

    const scoped = entriesForTask(whole, "task-2");

    // A new object with its own array; the model's state is not rewritten.
    expect(scoped).not.toBe(whole);
    expect(scoped.items).not.toBe(originalItems);
    expect(whole.items).toBe(originalItems);
    expect(whole.items.map((item) => item.id)).toEqual(["a1", "a2"]);
    expect(whole.pendingCount).toBe(2);
    expect(scoped.items.map((item) => item.id)).toEqual(["a2"]);
    expect(scoped.online).toBe(false);

    // The model still addresses the node-wide list by id: a1 is scoped out of
    // this conversation's view, yet the model keeps and can decide it.
    model.setOnline(true);
    await expect(model.approve("a1")).resolves.toMatchObject({ ok: true });
    const after = model.getState();
    expect(after.items.map((item) => item.id)).toEqual(["a1", "a2"]);
    expect(after.pendingCount).toBe(1);
    // The snapshot taken before the decision is unchanged by it.
    expect(whole.items.map((item) => item.id)).toEqual(["a1", "a2"]);
    expect(whole.pendingCount).toBe(2);
  });
});
