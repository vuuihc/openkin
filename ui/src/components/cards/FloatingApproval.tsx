import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Approval } from "../../api/client";
import { useT } from "../../i18n/react";
import ErrorBoundary from "../ErrorBoundary";
import ApprovalCard from "./ApprovalCard";

type Decision = "approved" | "denied";

type Props = {
  /** Waiting approvals, in the order the shared resource publishes them. */
  approvals: Approval[];
  /** What the task behind an approval is called, for saying who is blocked. */
  titleFor: (taskId: string) => string;
  busy: Record<string, Decision | undefined>;
  onDecide: (id: string, decision: Decision) => void;
  onOpenTask: (taskId: string) => void;
  /** The phone's dock is on screen, so the card has to clear it. */
  raised: boolean;
  /** The route, so a measurement taken on one screen is redone on the next. */
  screenKey: string;
  /**
   * This route has a composer pinned to the bottom. The band is marked only by
   * the pane the reader is looking at, and a cold load draws it after the
   * shell, so on these routes the card waits for it instead of guessing.
   */
  expectsBottomChrome: boolean;
  onOpenPath?: (path: string) => void;
};

/**
 * The one pending approval that is not already on screen, floating.
 *
 * It shows the approval that has been waiting longest, not the newest: an agent
 * that stopped twenty minutes ago has been stopped for twenty minutes, and a
 * card that always shows the latest arrival is a queue that starves. The rest
 * are counted in the strip above it — a reader can answer this one, or open the
 * task and deal with the queue where the transcript explains it.
 *
 * The card itself is `ApprovalCard`, the same one the inbox and the transcript
 * use. It is the decision surface, with the diff and the buttons; this
 * component only decides where it sits and which one it shows.
 */
export default function FloatingApproval({
  approvals,
  titleFor,
  busy,
  onDecide,
  onOpenTask,
  raised,
  screenKey,
  expectsBottomChrome,
  onOpenPath,
}: Props) {
  const tr = useT();
  const surfaceRef = useRef<HTMLDivElement>(null);
  // Answering unmounts the card that held focus. A keyboard user would be
  // dropped to the document body, mid-queue, with nothing to tab from. The
  // decision is kept, not just a flag: a reader who denied one request must
  // not land on *Approve* for the next, one reflexive Enter away from
  // approving what they were declining.
  const keepFocus = useRef<Decision | null>(null);
  // How far the page's own bottom furniture reaches up the screen: the
  // composer, and the strip above it that says how many items are waiting. On
  // a conversation that band is ~120px and grows with attachments, so a fixed
  // offset either covers the input or floats absurdly high above it. Measured
  // instead, from an element the page marks — see `data-kin-bottom-chrome`.
  const [bottom, setBottom] = useState<number | null>(null);

  // The oldest by its own timestamp rather than by position: the resource
  // happens to publish newest-first, and a card whose queue order depends on
  // that is one sort change away from starving the request it was built to
  // surface.
  const current = approvals.reduce<Approval | null>(
    (oldest, approval) =>
      !oldest || approval.created_at < oldest.created_at ? approval : oldest,
    null,
  );
  const currentId = current?.id ?? "";
  const hasAny = current !== null;

  useEffect(() => {
    const decision = keepFocus.current;
    if (!decision) return;
    keepFocus.current = null;
    // The same button the reader used, on the card that is now showing: a
    // keyboard user answering a queue keeps the key that answers it.
    const next = surfaceRef.current?.querySelector<HTMLElement>(
      decision === "approved" ? ".kin-btn-approve" : ".kin-btn-deny",
    );
    next?.focus({ preventScroll: true });
  }, [currentId]);

  // A decision that failed leaves the same card up and the intent to move
  // focus still armed. Without this, minutes later — an approval expiring out
  // of the queue, say — a *different* approval becoming current would pull
  // focus out of whatever the reader had moved on to.
  const busyForCurrent = current ? (busy[current.id] ?? null) : null;
  useEffect(() => {
    if (keepFocus.current && !busyForCurrent) keepFocus.current = null;
  }, [busyForCurrent, currentId]);

  // `screenKey` is the route: on a conversation the composer comes and goes
  // with it, and an effect that ran once would keep the offset of a screen the
  // reader has left. `hasAny` keeps a route with nothing to show from
  // installing an observer over the whole document.
  //
  // Layout, not passive: the measurement sets state that positions the card,
  // and a mount (a route change, or coming back from the drawer) would
  // otherwise paint one frame at the fallback offset, over the composer.
  useLayoutEffect(() => {
    if (!expectsBottomChrome || !hasAny) {
      setBottom(null);
      return;
    }
    let chrome: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let mutations: MutationObserver | null = null;

    const measure = () => {
      if (!chrome) return;
      const rect = chrome.getBoundingClientRect();
      // A band that is not laid out has no box; an offset measured against
      // zero would push the card off the top of the screen. Keep watching.
      if (rect.width === 0 && rect.height === 0) {
        setBottom(null);
        return;
      }
      // Above the band, with the same 8px breath the dock gets.
      setBottom(Math.max(0, Math.round(window.innerHeight - rect.top + 8)));
    };

    const attach = () => {
      // Only the pane on screen marks its band, so this is scoped by the page
      // rather than filtered here — a cached conversation renders the same
      // composer, `display:none`, and measuring it would be measuring nothing.
      const found = document.querySelector<HTMLElement>("[data-kin-bottom-chrome]");
      if (!found) return false;
      chrome = found;
      measure();
      window.addEventListener("resize", measure);
      // ResizeObserver is absent in jsdom; the measurement above still runs
      // once there, which is all a test needs.
      resizeObserver =
        typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
      resizeObserver?.observe(found);
      return true;
    };

    if (!attach()) {
      // A conversation draws its composer after the task loads, so on a cold
      // load the band is not there yet. Watch for it until it arrives or the
      // reader leaves; the observer lives no longer than the route does.
      setBottom(null);
      mutations = new MutationObserver(() => {
        if (!attach()) return;
        mutations?.disconnect();
        mutations = null;
      });
      mutations.observe(document.body, { childList: true, subtree: true });
      return () => {
        mutations?.disconnect();
        resizeObserver?.disconnect();
        window.removeEventListener("resize", measure);
      };
    }

    return () => {
      window.removeEventListener("resize", measure);
      resizeObserver?.disconnect();
    };
  }, [screenKey, expectsBottomChrome, hasAny]);

  if (!current) return null;

  const waiting = approvals.length - 1;
  // The shell's task list first: it is the live row and follows a rename. The
  // title the API joined onto the approval when the list was read is the
  // fallback for a task outside that page — and approvals that arrive while
  // the app is open carry none at all, so "another task" is the honest last
  // resort rather than a name invented for a task this card cannot see.
  const title = titleFor(current.task_id) || current.task_title;

  const decide = (decision: Decision) => {
    keepFocus.current = surfaceRef.current?.contains(document.activeElement) ? decision : null;
    onDecide(current.id, decision);
  };

  return (
    <aside
      ref={surfaceRef}
      aria-label={tr("approval.floatingLabel")}
      style={bottom === null ? undefined : { bottom }}
      className={[
        // `fixed` because it has to survive scrolling every screen it appears
        // over, and because a floating surface is what makes the elevation
        // honest — nothing behind it moves to make room.
        "pointer-events-none fixed inset-x-3 z-40 flex flex-col gap-1.5",
        "md:inset-x-auto md:right-6 md:w-[24rem]",
        // Where the page has no bottom furniture to measure, the dock decides:
        // above it and its "new chat" button when it is on screen, and above
        // where it would be when the reader is in a pushed conversation.
        bottom === null &&
          (raised
            ? "bottom-[calc(9.25rem+env(safe-area-inset-bottom))]"
            : "bottom-[calc(5.5rem+env(safe-area-inset-bottom))]"),
        "md:bottom-6",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* A live region: an approval arriving while the reader is on another
          screen is the whole point of this card, and a silent arrival means
          the agent stays stopped until someone happens to look. */}
      <div
        role="status"
        aria-live="polite"
        className="kin-glass pointer-events-auto flex items-center gap-2 self-start rounded-full py-1 pl-3 pr-2 shadow-e2"
      >
        <span className="text-caption font-semibold uppercase tracking-label text-kin-muted">
          {tr("approval.floatingLabel")}
        </span>
        <button
          type="button"
          onClick={() => onOpenTask(current.task_id)}
          title={tr("approval.openTask")}
          className="max-w-[13rem] truncate rounded-full px-1 py-0.5 text-caption font-medium text-kin-blue-ink hover:underline"
        >
          {title || tr("approval.floatingFallback")}
        </button>
        {waiting > 0 && (
          <>
            {/* The visible `+1` is a count with no noun; the label is what a
                screen reader should hear, and `aria-label` on a plain span is
                ignored — so the number is hidden from AT and the sentence is
                rendered for it instead. */}
            <span
              aria-hidden="true"
              title={tr("approval.moreWaiting", { n: waiting })}
              className="rounded-full bg-kin-orange/15 px-1.5 py-0.5 text-caption font-semibold text-kin-orange-ink"
            >
              +{waiting}
            </span>
            <span className="sr-only">{tr("approval.moreWaiting", { n: waiting })}</span>
          </>
        )}
      </div>
      <div className="pointer-events-auto max-h-[50dvh] overflow-y-auto kin-scroll md:max-h-[60dvh]">
        {/* Keyed by the approval: a payload that cannot render costs this one
            card, and the boundary's "caught" state is thrown away when the
            queue moves on — a permanently wedged boundary would hide every
            later approval until a reload, which is the opposite of the point.
            (Error boundaries catch render throws only; the payload is consumed
            in render, which is where an agent-supplied value can hurt.) */}
        <ErrorBoundary key={current.id} fallback={null}>
          <ApprovalCard
            approval={current}
            busy={busy[current.id] ?? null}
            onApprove={() => decide("approved")}
            onDeny={() => decide("denied")}
            onOpenPath={onOpenPath}
            showKeys={false}
          />
        </ErrorBoundary>
      </div>
    </aside>
  );
}
