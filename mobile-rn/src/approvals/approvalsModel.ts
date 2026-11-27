import type {
  Approval,
  ApprovalDecisionRequest,
  UserQuestion,
  UserQuestionResponse,
} from "@ui/api/contract";
import type { Session } from "../auth/tokenStore";
import {
  apiFetch,
  DEFAULT_TIMEOUT_MS,
  type TransportReason,
} from "../api/transport";

/**
 * KIN-MOBILE-001 R5 — approvals and questions, headless.
 *
 * R5b draws the cards; this module owns the reads and the one-way transitions
 * the signed story asks for: `idle -> submitting -> resolved` per item, with a
 * failure restoring the item to `idle` and recording why. It adds no endpoint
 * and no payload shape: the paths and bodies below are the web console's
 * (`ui/src/api/client.ts`, `listApprovals` / `listUserQuestions` /
 * `decideApproval` / `answerUserQuestion`), and the record types are the shared
 * generated ones.
 *
 * Two rules shape the async edges:
 *
 * - every request carries a bound (AGENTS.md §13), so a dead node fails as
 *   `unreachable` instead of leaving a card in `submitting` forever;
 * - a decision or answer carries the revision of the list that showed the
 *   card. If a reload replaced that list while the request was in flight, the
 *   response is dropped: the replacement list, not the answer to the old one,
 *   is what the screen asked for (AGENTS.md §11).
 *
 * No user-visible sentence lives here. Results and failures are stable codes
 * and server records; R5b maps them to the shared i18n catalogue.
 */

export const pendingApprovalsPath = "/api/approvals?status=pending";
export const pendingQuestionsPath = "/api/user-questions?status=pending";

export function approvalDecisionPath(id: string): string {
  return `/api/approvals/${encodeURIComponent(id)}/decision`;
}

export function answerQuestionPath(id: string): string {
  return `/api/user-questions/${encodeURIComponent(id)}/answer`;
}

export type ApprovalsStatus = "idle" | "loading" | "ready" | "error";

export type EntryPhase = "idle" | "submitting" | "resolved";

export type EntryFailure = {
  reason: TransportReason;
  status: number | null;
};

/** The one-line result a handled card keeps. Presentation localizes it. */
export type EntryResolution =
  | { kind: "approval"; decision: Approval["decision"] }
  | { kind: "question"; text: string };

export type ApprovalEntry = {
  key: string;
  kind: "approval";
  id: string;
  createdAt: number;
  approval: Approval;
  phase: EntryPhase;
  /** Whether this item still counts toward the pending badge. */
  pending: boolean;
  resolution?: EntryResolution;
  failure?: EntryFailure;
};

export type QuestionEntry = {
  key: string;
  kind: "question";
  id: string;
  createdAt: number;
  question: UserQuestion;
  phase: EntryPhase;
  pending: boolean;
  resolution?: EntryResolution;
  failure?: EntryFailure;
};

export type PendingEntry = ApprovalEntry | QuestionEntry;

export type ApprovalsState = {
  status: ApprovalsStatus;
  items: PendingEntry[];
  pendingCount: number;
  /** False disables submit; already-read items stay in `items`. */
  online: boolean;
  error?: EntryFailure;
  /** Bumped when a load replaces the list; late answers from older lists drop. */
  revision: number;
};

export type SubmitBlockReason =
  | "offline"
  | "missing"
  | "busy"
  | "resolved"
  | "stale";

export type SubmitReason = SubmitBlockReason | TransportReason;

export type SubmitResult =
  | { ok: true; entry: PendingEntry }
  | { ok: false; reason: SubmitReason; status?: number | null };

export type ApprovalsOptions = {
  origin: string;
  /** The stored session; a Hub session sends its cookie instead of a token. */
  session?: Session | null;
  token?: string | null;
  /** Tests inject a recording fetch; production uses the platform fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request bound (AGENTS.md §13). Tests shrink it. */
  timeoutMs?: number;
};

export type ApprovalsModel = {
  getState(): ApprovalsState;
  subscribe(listener: (state: ApprovalsState) => void): () => void;
  /** Read pending approvals and questions; the latest call wins. */
  load(): Promise<ApprovalsState>;
  approve(id: string): Promise<SubmitResult>;
  deny(id: string): Promise<SubmitResult>;
  answer(id: string, text: string): Promise<SubmitResult>;
  /** Network reachability as the screen sees it. Offline keeps read items. */
  setOnline(online: boolean): void;
  /** Abort in-flight reads and decisions; later answers are dropped. */
  dispose(): void;
};

type EntryPatch = {
  phase?: EntryPhase;
  pending?: boolean;
  failure?: EntryFailure;
  resolution?: EntryResolution;
  approval?: Approval;
  question?: UserQuestion;
};

function failureOf(result: { reason: TransportReason; status: number | null }): EntryFailure {
  return { reason: result.reason, status: result.status };
}

function fromApproval(approval: Approval): ApprovalEntry {
  return {
    key: `approval:${approval.id}`,
    kind: "approval",
    id: approval.id,
    createdAt: approval.created_at,
    approval,
    phase: "idle",
    pending: approval.decision === "pending",
  };
}

function fromQuestion(question: UserQuestion): QuestionEntry {
  return {
    key: `question:${question.id}`,
    kind: "question",
    id: question.id,
    createdAt: question.created_at,
    question,
    phase: "idle",
    pending: question.status === "pending",
  };
}

function countPending(items: PendingEntry[]): number {
  let count = 0;
  for (const item of items) if (item.pending) count += 1;
  return count;
}

/**
 * The cards one conversation owns, as a view of the model's state.
 *
 * The lists are node-wide (`/api/approvals?status=pending`), so a conversation
 * must show only the records whose `task_id` is its own — the same rule the web
 * console applies (`ui/src/pages/TaskDetailPage.tsx`: `item.task_id === id`).
 * The returned state is a new object with a new item array; the model keeps the
 * node-wide list untouched, because `approve` / `deny` / `answer` address items
 * by id and a decision on a scoped-out card must still resolve.
 */
export function entriesForTask(
  state: ApprovalsState,
  taskId: string,
): ApprovalsState {
  const items = state.items.filter((entry) =>
    entry.kind === "approval"
      ? entry.approval.task_id === taskId
      : entry.question.task_id === taskId,
  );
  return { ...state, items, pendingCount: countPending(items) };
}

export function createApprovals(options: ApprovalsOptions): ApprovalsModel {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const listeners = new Set<(state: ApprovalsState) => void>();
  const controllers = new Set<AbortController>();
  // Keyed by card so a replaced list can abort only its own kind's requests,
  // and a settlement removes only the request it still owns.
  const inFlight = new Map<string, AbortController>();
  let state: ApprovalsState = {
    status: "idle",
    items: [],
    pendingCount: 0,
    online: true,
    revision: 0,
  };
  let loadCalls = 0;
  // Per-kind list generations. An answer is dropped only when the list that
  // showed its card was replaced; a failed read of the other kind must not
  // strand a card in `submitting` (AGENTS.md §11 and the "never stuck" rule).
  let approvalRevision = 0;
  let questionRevision = 0;
  // Monotonic revision bumped when a decision or answer resolves a card. A
  // list read that began before that moment carries an older snapshot and must
  // not re-pend the card (AGENTS.md §11).
  let mutationRevision = 0;
  const resolutionRevisions = new Map<string, number>();
  let disposed = false;

  function publish(next: ApprovalsState): void {
    state = next;
    for (const listener of [...listeners]) listener(state);
  }

  function request<T>(
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal: AbortSignal;
    },
  ) {
    return apiFetch<T>(options.origin, path, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      session: options.session,
      token: options.token,
      fetchImpl: options.fetchImpl,
      timeoutMs,
      signal: init.signal,
    });
  }

  function withPatch(item: PendingEntry, patch: EntryPatch): PendingEntry {
    // `"failure" in patch` rather than `??`: an explicit `undefined` is how a
    // retry clears the previous reason, and `??` would keep the old one.
    if (item.kind === "approval") {
      return {
        ...item,
        phase: patch.phase ?? item.phase,
        pending: patch.pending ?? item.pending,
        failure: "failure" in patch ? patch.failure : item.failure,
        resolution: "resolution" in patch ? patch.resolution : item.resolution,
        approval: patch.approval ?? item.approval,
      };
    }
    return {
      ...item,
      phase: patch.phase ?? item.phase,
      pending: patch.pending ?? item.pending,
      failure: "failure" in patch ? patch.failure : item.failure,
      resolution: "resolution" in patch ? patch.resolution : item.resolution,
      question: patch.question ?? item.question,
    };
  }

  function patchEntry(key: string, patch: EntryPatch): void {
    let changed = false;
    const items = state.items.map((item) => {
      if (item.key !== key) return item;
      changed = true;
      return withPatch(item, patch);
    });
    if (!changed) return;
    publish({ ...state, items, pendingCount: countPending(items) });
  }

  // A replaced list owns its cards: a decision or answer still pending against
  // the old list is aborted, so the fresh card is actionable at once instead
  // of being blocked as `busy` by a superseded request (AGENTS.md §11).
  function abortReplaced(prefix: "approval:" | "question:"): void {
    for (const [key, controller] of [...inFlight]) {
      if (!key.startsWith(prefix)) continue;
      inFlight.delete(key);
      controller.abort();
    }
  }

  // The cards a replacement list must carry: entries resolved after the read
  // began, whose server snapshot predates the decision. Records older than the
  // read are dropped; no later read can consult them.
  function carriedAfter<T extends PendingEntry>(
    kept: T[],
    prefix: "approval:" | "question:",
    startedAt: number,
  ): Map<string, T> {
    const carried = new Map<string, T>();
    for (const item of kept) {
      const revision = resolutionRevisions.get(item.key);
      if (revision !== undefined && revision > startedAt) carried.set(item.key, item);
    }
    for (const [key, revision] of [...resolutionRevisions]) {
      if (revision <= startedAt && key.startsWith(prefix)) resolutionRevisions.delete(key);
    }
    return carried;
  }

  async function load(): Promise<ApprovalsState> {
    if (disposed) return state;
    const call = ++loadCalls;
    const startedAt = mutationRevision;
    const controller = new AbortController();
    controllers.add(controller);
    publish({ ...state, status: "loading", error: undefined });

    // Both reads are bounded by `timeoutMs`; `apiFetch` never rejects, so the
    // pair always settles and one dead list cannot hide the other.
    const [approvals, questions] = await Promise.all([
      request<Approval[]>(pendingApprovalsPath, { signal: controller.signal }),
      request<UserQuestion[]>(pendingQuestionsPath, { signal: controller.signal }),
    ]);
    controllers.delete(controller);

    // A newer load owns the screen now; its answer is the current one.
    if (disposed || call !== loadCalls) return state;

    const keptApprovals = state.items.filter(
      (item): item is ApprovalEntry => item.kind === "approval",
    );
    const keptQuestions = state.items.filter(
      (item): item is QuestionEntry => item.kind === "question",
    );

    // A failed read keeps that kind's already-read items (the signed row says
    // a disconnect must not erase what the person has seen). A successful one
    // replaces them, except for cards resolved while this read was on the
    // wire: that snapshot predates the decision (AGENTS.md §11).
    let approvalItems: ApprovalEntry[] = keptApprovals;
    if (approvals.ok && Array.isArray(approvals.data)) {
      abortReplaced("approval:");
      const carried = carriedAfter(keptApprovals, "approval:", startedAt);
      approvalItems = approvals.data
        .map(fromApproval)
        .map((item) => carried.get(item.key) ?? item);
    }
    let questionItems: QuestionEntry[] = keptQuestions;
    if (questions.ok && Array.isArray(questions.data)) {
      abortReplaced("question:");
      const carried = carriedAfter(keptQuestions, "question:", startedAt);
      questionItems = questions.data
        .map(fromQuestion)
        .map((item) => carried.get(item.key) ?? item);
    }

    const items: PendingEntry[] = [
      ...approvalItems.sort((a, b) => b.createdAt - a.createdAt),
      ...questionItems.sort((a, b) => a.createdAt - b.createdAt),
    ];
    const error = !approvals.ok
      ? failureOf(approvals)
      : !questions.ok
        ? failureOf(questions)
        : undefined;
    // Existing rows make a failed refresh a stale-but-usable list, not an
    // empty error page.
    const status: ApprovalsStatus =
      approvals.ok || questions.ok || items.length > 0 ? "ready" : "error";

    // Only a list that was actually re-read replaces the flow that showed its
    // cards; a retained list keeps both its items and their in-flight answers.
    if (approvals.ok) approvalRevision += 1;
    if (questions.ok) questionRevision += 1;

    publish({
      status,
      items,
      pendingCount: countPending(items),
      online: state.online,
      error,
      revision:
        approvals.ok || questions.ok ? state.revision + 1 : state.revision,
    });
    return state;
  }

  type Preflight =
    | { ok: true; entry: PendingEntry; revision: number }
    | { ok: false; reason: SubmitBlockReason };

  function preflight(key: string, kind: "approval" | "question"): Preflight {
    if (disposed) return { ok: false, reason: "stale" };
    const entry = state.items.find((item) => item.key === key);
    if (!entry) return { ok: false, reason: "missing" };
    if (entry.phase === "resolved") return { ok: false, reason: "resolved" };
    // One request per item: a held button must not post a second decision.
    if (entry.phase === "submitting" || inFlight.has(key)) {
      return { ok: false, reason: "busy" };
    }
    if (!state.online) return { ok: false, reason: "offline" };
    return {
      ok: true,
      entry,
      revision: kind === "approval" ? approvalRevision : questionRevision,
    };
  }

  async function decide(
    id: string,
    decision: "approved" | "denied",
  ): Promise<SubmitResult> {
    const key = `approval:${id}`;
    const gate = preflight(key, "approval");
    if (!gate.ok) return gate;
    const { revision } = gate;
    const controller = new AbortController();
    controllers.add(controller);
    inFlight.set(key, controller);
    patchEntry(key, { phase: "submitting", failure: undefined, resolution: undefined });

    const payload: ApprovalDecisionRequest = { decision };
    const outcome = await request<Approval>(approvalDecisionPath(id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    controllers.delete(controller);
    // A replaced list may have already aborted and cleared this card; only the
    // owner of the current mapping may remove it.
    if (inFlight.get(key) === controller) inFlight.delete(key);

    // The list that showed this card is gone: its answer must not resurrect it.
    if (disposed || approvalRevision !== revision) {
      return { ok: false, reason: "stale" };
    }

    if (!outcome.ok) {
      patchEntry(key, { phase: "idle", failure: failureOf(outcome) });
      return { ok: false, reason: outcome.reason, status: outcome.status };
    }

    const current = state.items.find((item) => item.key === key);
    if (!current || current.kind !== "approval") {
      return { ok: false, reason: "stale" };
    }
    mutationRevision += 1;
    resolutionRevisions.set(key, mutationRevision);
    const decided = outcome.data ?? current.approval;
    patchEntry(key, {
      phase: "resolved",
      pending: false,
      failure: undefined,
      approval: decided,
      resolution: { kind: "approval", decision: decided.decision },
    });
    const entry = state.items.find((item) => item.key === key);
    return entry ? { ok: true, entry } : { ok: false, reason: "stale" };
  }

  async function answer(id: string, text: string): Promise<SubmitResult> {
    const key = `question:${id}`;
    const gate = preflight(key, "question");
    if (!gate.ok) return gate;
    const { revision } = gate;
    const controller = new AbortController();
    controllers.add(controller);
    inFlight.set(key, controller);
    patchEntry(key, { phase: "submitting", failure: undefined, resolution: undefined });

    // The web console's answer body: an option list plus free text. R5's core
    // takes the free-text answer; option selection is R5b's shape to pass.
    const payload: UserQuestionResponse = { selected: [], other_text: text };
    const outcome = await request<UserQuestion>(answerQuestionPath(id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    controllers.delete(controller);
    if (inFlight.get(key) === controller) inFlight.delete(key);

    if (disposed || questionRevision !== revision) {
      return { ok: false, reason: "stale" };
    }

    if (!outcome.ok) {
      patchEntry(key, { phase: "idle", failure: failureOf(outcome) });
      return { ok: false, reason: outcome.reason, status: outcome.status };
    }

    const current = state.items.find((item) => item.key === key);
    if (!current || current.kind !== "question") {
      return { ok: false, reason: "stale" };
    }
    mutationRevision += 1;
    resolutionRevisions.set(key, mutationRevision);
    patchEntry(key, {
      phase: "resolved",
      pending: false,
      failure: undefined,
      question: outcome.data ?? current.question,
      resolution: { kind: "question", text },
    });
    const entry = state.items.find((item) => item.key === key);
    return entry ? { ok: true, entry } : { ok: false, reason: "stale" };
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    approve: (id) => decide(id, "approved"),
    deny: (id) => decide(id, "denied"),
    answer,
    setOnline(online) {
      if (disposed || state.online === online) return;
      publish({ ...state, online });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      inFlight.clear();
      resolutionRevisions.clear();
      listeners.clear();
    },
  };
}
