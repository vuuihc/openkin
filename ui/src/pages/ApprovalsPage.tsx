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
import { inboxKeyOutcome, inboxViewState } from "../lib/inboxKeyboard";
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

  // A live update can shorten the list under the ring — deciding an approval
  // removes it from `items` — and an index that outlives its card is how a
  // keystroke ends up deciding something nobody ringed. Clamping is the whole
  // reason `inboxKeyboard` can insist that a decision lands on the ring.
  useEffect(() => {
    setFocusIdx((i) => Math.min(i, Math.max(0, items.length - 1)));
  }, [items.length]);

  // A takeover of nothing is meaningless: deciding the last approval away empties
  // the list, and holding the cursor there leaves the question un-ringed while it
  // still advertises its `1`–`9` — keys that do nothing. Handing it straight back
  // re-arms the card. `inboxKeyOutcome` keeps `k` working in the frame before
  // this effect lands, so the two are belt and braces, not the same fix twice.
  useEffect(() => {
    if (!items.length) setCursorTakenOver(false);
  }, [items.length]);

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

  // A deep link that named a question parks the inbox's keyboard cursor: the
  // ring has to mean one thing, and `a`/`d` act on the card they ring — so until
  // someone moves the cursor themselves, nothing is ringed and `a`/`d` do
  // nothing. `j`/`k` are navigation, not a decision, and they take it back;
  // `k` from the top of the list gives it back again.
  const [cursorTakenOver, setCursorTakenOver] = useState(false);
  // The takeover belongs to the link it interrupted, not to the page. Without
  // this, a `j` on one deep link would leave the *next* question un-ringed and —
  // since the ring and the keys move together — keyboard-dead on arrival.
  useEffect(() => setCursorTakenOver(false), [focusId]);
  // The arming rule and the ring are derived together, in one place, so the page
  // cannot ring one card while arming the keys for another. It has broken exactly
  // that way twice; both times the derivation lived here and no test could reach
  // it. See `inboxViewState`.
  const {
    parkedQuestionId,
    armed: approvalsKeyboardLive,
    questionRinged: questionFocusId,
  } = inboxViewState(focus, { focusIdx, cursorTakenOver });

  // The ids this page decided or answered itself. A link that named one of them
  // is spent, not stale, and the page should not answer the notification it just
  // carried out with "that one is not waiting any more".
  const handledHere = useRef<Set<string>>(new Set());

  // The ring's own element, by id, so a press that moves it can bring it into
  // view. Separate from `hitRef`: that one is the deep link's landing and is
  // deliberately one-shot, while this is someone pressing a key.
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      // Built here rather than closed over, so every value the transition reads
      // is a dependency of this effect and the array below can be read as the
      // complete list — `keyState` itself is a fresh object each render, and
      // naming it would say nothing about when the closure is stale.
      const action = inboxKeyOutcome(e.key, items, { focusIdx, cursorTakenOver, parkedQuestionId });
      if (action.kind === "move") {
        setCursorTakenOver(action.state.cursorTakenOver);
        setFocusIdx(action.state.focusIdx);
        // Taking over or walking back can ring a card the person cannot see:
        // approvals render above questions, so `j` from a question deep link
        // lands off the top of the screen and `k` back onto a question that is
        // below the fold — either would look like nothing happened. `nearest`
        // moves the page only if it has to. Which card that is comes from the
        // transition; picking it here is how the two arms of a ternary nobody
        // tested got swapped once, scrolling to the card behind the ringed one.
        if (action.moved !== "cursor" && action.ringId) {
          rowRefs.current.get(action.ringId)?.scrollIntoView({ block: "nearest" });
        }
      } else if (action.kind === "decide") {
        void onDecide(action.id, action.decision);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `parkedQuestionId` alongside the cursor: a link that moves from one
    // question to another leaves everything else unchanged, and a closure
    // without it walks back to the question that already left.
  }, [items, focusIdx, cursorTakenOver, parkedQuestionId]);

  async function onDecide(id: string, decision: PendingDecision) {
    handledHere.current.add(id);
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
    handledHere.current.add(id);
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
            an error — a handled item is the normal end of a notification, and
            one this page handled itself is not worth explaining at all. */}
        {!loading && !error && focus.kind === "missing" && !handledHere.current.has(focus.id) && (
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
                <li
                  key={a.id}
                  ref={(node) => {
                    if (node) rowRefs.current.set(a.id, node);
                    else rowRefs.current.delete(a.id);
                    if (a.id === hitId) hitRef.current = node;
                  }}
                >
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
                <li
                  key={q.id}
                  ref={(node) => {
                    // Also in `rowRefs`: `k` from the top of the approvals walks
                    // back to this card, and that move has to be visible.
                    if (node) rowRefs.current.set(q.id, node);
                    else rowRefs.current.delete(q.id);
                    if (q.id === hitId) hitRef.current = node;
                  }}
                >
                  <UserQuestionCard
                    question={q}
                    focused={q.id === questionFocusId}
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
