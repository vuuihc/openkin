import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, answerUserQuestion, decideApproval } from "../api/client";
import { liveResources } from "../api/liveResources";
import { usePendingResources, useTaskList } from "../api/useLiveResources";
import ApprovalCard from "../components/cards/ApprovalCard";
import UserQuestionCard from "../components/cards/UserQuestionCard";
import RunningTaskCard from "../components/cards/RunningTaskCard";
import { ApprovalListSkeleton, SlowConnectHint } from "../components/Skeleton";
import { useSlowHint } from "../hooks/useSlowHint";
import { focusedId, resolveInboxFocus } from "../lib/inboxFocus";
import { useAppStore } from "../store/appStore";
import { isTerminal } from "../api/client";
import { Link, useSearchParams } from "react-router-dom";
import { useT } from "../i18n/react";

type PendingDecision = "approved" | "denied";

/**
 * Inbox — design 3g. Pending approvals first; running tasks below.
 */
export default function ApprovalsPage() {
  const tr = useT();
  const pending = usePendingResources();
  const taskList = useTaskList({ limit: 50 });
  const items = pending.data.approvals;
  const questions = pending.data.questions;
  const running = useMemo(
    () => taskList.data.filter((task) => !isTerminal(task.status)),
    [taskList.data],
  );
  const loading = !pending.loaded || !taskList.loaded;
  const resourceError = pending.error ?? taskList.error;
  const error =
    resourceError instanceof ApiError && resourceError.status === 401
      ? null
      : resourceError instanceof Error
        ? resourceError.message
        : resourceError
          ? tr("inbox.loadFailed")
          : null;
  const [busy, setBusy] = useState<Record<string, PendingDecision>>({});
  const [answerBusy, setAnswerBusy] = useState<Record<string, boolean>>({});
  const [focusIdx, setFocusIdx] = useState(0);
  const pushToast = useAppStore((s) => s.pushToast);
  const slow = useSlowHint(loading);
  const [searchParams] = useSearchParams();
  const focusId = searchParams.get("focus");

  const focus = useMemo(
    () => resolveInboxFocus(focusId, items, questions),
    [focusId, items, questions],
  );

  useEffect(() => {
    if (focus.kind === "approval") setFocusIdx(focus.idx);
  }, [focus]);

  /**
   * The landing itself: bring the named card into view, once.
   *
   * A ring somewhere below the fold answers "which one?" with "one of these,
   * further down". Once per id, so a live update or a keystroke cannot yank the
   * page back while the person is reading it.
   */
  const hitRef = useRef<HTMLLIElement | null>(null);
  const scrolledFor = useRef<string | null>(null);
  const hitId = focusedId(focus);
  useEffect(() => {
    if (!hitId || loading || scrolledFor.current === hitId) return;
    const el = hitRef.current;
    if (!el) return;
    scrolledFor.current = hitId;
    el.scrollIntoView({ block: "center" });
  }, [hitId, loading, focus]);

  // A deep link that named a question takes the cursor off the approvals: the
  // ring has to mean one thing, and `a`/`d` have to act on the card they ring.
  const approvalsKeyboardLive = focus.kind !== "question";

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (!items.length) return;
      // Nothing is ringed while a question holds the focus, and approving the
      // first approval instead would be the worst kind of surprise.
      if (!approvalsKeyboardLive) return;
      if (e.key === "j" || e.key === "J") setFocusIdx((i) => Math.min(items.length - 1, i + 1));
      else if (e.key === "k" || e.key === "K") setFocusIdx((i) => Math.max(0, i - 1));
      else if (e.key === "a" || e.key === "A") {
        const a = items[focusIdx] ?? items[0];
        if (a) void onDecide(a.id, "approved");
      } else if (e.key === "d" || e.key === "D") {
        const a = items[focusIdx] ?? items[0];
        if (a) void onDecide(a.id, "denied");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, focusIdx, approvalsKeyboardLive]);

  async function onDecide(id: string, decision: PendingDecision) {
    setBusy((b) => ({ ...b, [id]: decision }));
    try {
      const updated = await decideApproval(id, decision);
      liveResources.applyMessage({ kind: "approval_update", data: updated });
      setBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
    } catch (e) {
      setBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
      pushToast(e instanceof Error ? e.message : tr("inbox.decisionFailed"), "error");
      void liveResources.refreshPending();
    }
  }

  async function onAnswer(id: string, body: { selected: string[]; other_text: string }) {
    setAnswerBusy((b) => ({ ...b, [id]: true }));
    try {
      const updated = await answerUserQuestion(id, body);
      liveResources.applyMessage({ kind: "user_question_update", data: updated });
      setAnswerBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
    } catch (e) {
      pushToast(e instanceof Error ? e.message : tr("question.answerFailed"), "error");
      setAnswerBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
    }
  }

  return (
    <div className="flex-1 overflow-y-auto kin-scroll">
      <div className="max-w-page-narrow mx-auto px-4 sm:px-6 py-6 sm:py-8">
        {/* One nav bar per phone screen: the shell's header carries this title
            there (and is a heading itself), so the page does not repeat it a
            step larger underneath. `md`, not `sm`: the shell header is
            `md:hidden`, so between the two the title would be on screen twice. */}
        <h1 className="hidden text-hero font-bold tracking-tight md:block">{tr("inbox.title")}</h1>
        <p className="text-strong text-kin-muted mt-1">
          {loading
            ? tr("inbox.loading")
            : items.length + questions.length === 0
              ? tr("inbox.noneWaiting")
              : tr("inbox.waiting", { count: items.length + questions.length })}
        </p>

        {/* The landing page explains a link that no longer names anything. Not
            an error — a handled item is the normal end of a notification. */}
        {!loading && !error && focus.kind === "missing" && (
          <div
            className="mt-4 rounded-lg border border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2 text-strong leading-5 text-kin-secondary"
            data-testid="inbox-focus-missing"
          >
            {tr("inbox.focusMissing")}{" "}
            <Link to="/inbox" className="font-medium text-kin-blue-ink hover:underline">
              {tr("inbox.focusShowAll")}
            </Link>
          </div>
        )}

        {loading && (
          <div className="mt-6 space-y-3">
            <SlowConnectHint show={slow} />
            <ApprovalListSkeleton />
          </div>
        )}

        {!loading && error && (
          <div
            className="mt-6 rounded-xl border border-kin-red/40 bg-kin-red/10 px-4 py-3 text-strong leading-5 text-kin-red-ink"
            role="alert"
          >
            {error}
          </div>
        )}

        {!loading &&
          !error &&
          items.length === 0 &&
          questions.length === 0 &&
          running.length === 0 && (
            <div className="mt-10 rounded-2xl border border-dashed border-[var(--kin-hairline-strong)] px-6 py-16 text-center">
              <p className="text-subtitle leading-6 font-medium text-kin-text">
                {tr("inbox.allClear")}
              </p>
              <p className="mt-1 text-strong leading-5 text-kin-secondary">
                {tr("inbox.allClearHint")}
              </p>
            </div>
          )}

        {!loading && items.length > 0 && (
          <div className="mt-6">
            <div className="text-caption font-semibold uppercase tracking-label text-kin-muted mb-3">
              {tr("inbox.approvalsSection")}
            </div>
            <ul className="space-y-3.5">
              {items.map((a, i) => (
                <li key={a.id} ref={a.id === hitId ? hitRef : undefined}>
                  <ApprovalCard
                    approval={a}
                    focused={approvalsKeyboardLive && i === focusIdx}
                    busy={busy[a.id] ?? null}
                    onApprove={() => void onDecide(a.id, "approved")}
                    onDeny={() => void onDecide(a.id, "denied")}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}

        {!loading && questions.length > 0 && (
          <div className="mt-8">
            <div className="text-caption font-semibold uppercase tracking-label text-kin-muted mb-3">
              {tr("inbox.questionsSection")}
            </div>
            <ul className="space-y-3.5">
              {questions.map((q) => (
                <li key={q.id} ref={q.id === hitId ? hitRef : undefined}>
                  <UserQuestionCard
                    question={q}
                    focused={focus.kind === "question" && q.id === focus.id}
                    busy={Boolean(answerBusy[q.id])}
                    onAnswer={(body) => void onAnswer(q.id, body)}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}

        {!loading && running.length > 0 && (
          <div className="mt-10">
            <div className="text-caption font-semibold uppercase tracking-label text-kin-muted mb-3">
              {tr("inbox.running")}
            </div>
            <ul className="space-y-2.5">
              {running.map((t) => (
                <li key={t.id}>
                  <Link to={`/tasks/${t.id}`} className="block">
                    <RunningTaskCard task={t} />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
