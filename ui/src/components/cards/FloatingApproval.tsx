import { useEffect, useRef, useState } from "react";
import type { Approval } from "../../api/client";
import { useT } from "../../i18n/react";
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
  onOpenPath,
}: Props) {
  const tr = useT();
  const surfaceRef = useRef<HTMLDivElement>(null);
  // Answering unmounts the card that held focus. A keyboard user would be
  // dropped to the document body, mid-queue, with nothing to tab from.
  const keepFocus = useRef(false);
  // How far the page's own bottom furniture reaches up the screen: the
  // composer, and the strip above it that says how many items are waiting. On
  // a conversation that band is ~120px and grows with attachments, so a fixed
  // offset either covers the input or floats absurdly high above it. Measured
  // instead, from an element the page marks — see `data-kin-bottom-chrome`.
  const [bottom, setBottom] = useState<number | null>(null);

  const current = approvals.length > 0 ? approvals[approvals.length - 1] : null;
  const currentId = current?.id ?? "";

  useEffect(() => {
    if (!keepFocus.current) return;
    keepFocus.current = false;
    const next = surfaceRef.current?.querySelector<HTMLElement>("button");
    next?.focus({ preventScroll: true });
  }, [currentId]);

  // `screenKey` is the route: on a conversation the composer comes and goes
  // with it, and an effect that ran once would keep the offset of a screen the
  // reader has left.
  useEffect(() => {
    let chrome: HTMLElement | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let mutations: MutationObserver | null = null;

    const measure = () => {
      if (!chrome) return;
      const rect = chrome.getBoundingClientRect();
      // Above the band, with the same 8px breath the dock gets.
      setBottom(Math.max(0, Math.round(window.innerHeight - rect.top + 8)));
    };

    const attach = () => {
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
      // load the band is not there yet — and an offset measured against
      // nothing would never be taken again. Watch for it, and stop watching
      // either when it arrives or when it is clear the page has none.
      setBottom(null);
      const giveUp = window.setTimeout(() => {
        mutations?.disconnect();
        mutations = null;
      }, 5000);
      mutations = new MutationObserver(() => {
        if (!attach()) return;
        window.clearTimeout(giveUp);
        mutations?.disconnect();
        mutations = null;
      });
      mutations.observe(document.body, { childList: true, subtree: true });
      return () => {
        window.clearTimeout(giveUp);
        mutations?.disconnect();
        resizeObserver?.disconnect();
        window.removeEventListener("resize", measure);
      };
    }

    return () => {
      window.removeEventListener("resize", measure);
      resizeObserver?.disconnect();
    };
  }, [screenKey]);

  if (!current) return null;

  const waiting = approvals.length - 1;
  const title = titleFor(current.task_id);

  const decide = (decision: Decision) => {
    keepFocus.current = surfaceRef.current?.contains(document.activeElement) ?? false;
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
      <div className="kin-glass pointer-events-auto flex items-center gap-2 self-start rounded-full py-1 pl-3 pr-2 shadow-e2">
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
          <span
            className="rounded-full bg-kin-orange/15 px-1.5 py-0.5 text-caption font-semibold text-kin-orange-ink"
            title={tr("approval.moreWaiting", { n: waiting })}
          >
            +{waiting}
          </span>
        )}
      </div>
      <div className="pointer-events-auto max-h-[50dvh] overflow-y-auto kin-scroll md:max-h-[60dvh]">
        <ApprovalCard
          approval={current}
          busy={busy[current.id] ?? null}
          onApprove={() => decide("approved")}
          onDeny={() => decide("denied")}
          onOpenPath={onOpenPath}
        />
      </div>
    </aside>
  );
}
