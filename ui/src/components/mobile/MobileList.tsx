import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { MobileChevron } from "./MobileHeader";

/**
 * The scroll body of a phone screen.
 *
 * `overflow-y-auto` on the page rather than on the document: the shell is a
 * fixed-height column, and a page that scrolled the document would take the
 * header and the footer with it. Its implicit `overflow-x: auto` would also let
 * the browser cancel a blank-content horizontal tab swipe: explicitly clip it.
 * Components that genuinely scroll horizontally own that behavior themselves.
 *
 * The phone footer floats over this container from KIN-CONTINUE-005, so the
 * body reserves `.phone-footer-clearance` at its end: without it the last row
 * would come to rest under the glass. The class is shared with Routines and
 * Settings and derives from the bar geometry in `index.css`.
 */
export function MobileScreen({
  children,
  className = "",
  scrollKey,
  scrollWhen,
}: {
  children: ReactNode;
  className?: string;
  /**
   * Remember where the reader was in this scroll body across visits.
   *
   * A route change unmounts the screen, and the browser drops `scrollTop` with
   * it; the session list therefore used to reopen at the top after every
   * destination and conversation (KIN-CONTINUE-002, "离开再回来"). The mark
   * rides sessionStorage, so it survives a route change but not a new tab, and
   * a restored position never overwrites a fresher one: while the list is
   * still short the restore is clamped to 0, and writing that back would erase
   * the place the reader actually left.
   */
  scrollKey?: string;
  /**
   * A value that changes when the rows inside do (the list passes their count).
   *
   * The restore has to retry after the data lands, and the scroll container's
   * own box never changes when rows arrive — its parents are fixed height — so
   * a ResizeObserver on it would never fire. The caller already knows when the
   * rows changed; this is that signal. The content wrapper also observes late
   * height changes after the row count has settled.
   */
  scrollWhen?: unknown;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const savedRef = useRef(0);
  const settledRef = useRef(true);
  const recordedRef = useRef(false);
  /**
   * The last offset the scroll handler saw. The unmount writes this instead of
   * rereading the node: a route change detaches or collapses the container
   * before the passive cleanup runs, so `scrollTop` is the clamp (usually 0) by
   * then, not the place the reader left.
   */
  const lastTopRef = useRef(0);
  /**
   * The reader has actually moved this body since the mount: a wheel, a key,
   * a touch drag past the tap slop, a scroll while a pointer is down, or the
   * browser taking a pan over (its `pointercancel`). A tap
   * is not movement — its pointerdown only stops the restore — so a body that
   * is hidden or whose content is swapped cannot launder its own clamp into a
   * position the reader chose.
   */
  const readerMovedRef = useRef(false);
  /** Where the current pointer went down, so a drag can be told from a tap. */
  const pointerOriginRef = useRef<{ x: number; y: number } | null>(null);

  /**
   * One restore attempt. `settled` is only spent when the saved offset is
   * actually reachable: setting `scrollTop` short of the content clamps it, and
   * settling there would freeze a half restored position.
   *
   * Shared by the caller's signal and the content-growth observer so both use
   * the same reachability rule.
   */
  const restore = useCallback(() => {
    if (!scrollKey || settledRef.current) return;
    const node = ref.current;
    if (!node) return;
    node.scrollTop = savedRef.current;
    const reachable = savedRef.current <= Math.max(0, node.scrollHeight - node.clientHeight);
    if (reachable) {
      settledRef.current = true;
      // The saved value is on screen again; recording it back is a no-op.
      recordedRef.current = true;
      lastTopRef.current = node.scrollTop;
    }
  }, [scrollKey]);

  // Listeners and recording: installed once per key, whether or not there is a
  // position to restore — a fresh tab is exactly the case that needs a writer.
  useLayoutEffect(() => {
    if (!scrollKey) return;
    const node = ref.current;
    if (!node) return;
    let saved = 0;
    try {
      saved = Number(sessionStorage.getItem(scrollKey) ?? "0") || 0;
    } catch {
      // No storage: the list opens at the top, as it always did.
    }
    savedRef.current = saved;
    settledRef.current = saved <= 0;
    recordedRef.current = false;
    lastTopRef.current = 0;
    readerMovedRef.current = false;
    pointerOriginRef.current = null;

    // A reader who starts scrolling while the data is still arriving has
    // chosen a new position; stop restoring rather than fight them. The touch
    // alone does not start recording: a tap that never scrolls must not
    // replace the remembered place with the top.
    const yieldToReader = () => {
      settledRef.current = true;
    };
    const movedByReader = () => {
      readerMovedRef.current = true;
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerOriginRef.current = { x: event.clientX, y: event.clientY };
      yieldToReader();
    };
    const onPointerUp = () => {
      pointerOriginRef.current = null;
    };
    // A cancel is the browser recognising a pan and taking the gesture over
    // before the first scroll event, so `touchmove` never sees an origin. That
    // recognition *is* the reader's movement — without it a touch drag back to
    // the top would be mistaken for the layout's clamp and snapped away.
    const onPointerCancel = () => {
      movedByReader();
      pointerOriginRef.current = null;
    };
    const onWheel = () => {
      movedByReader();
      yieldToReader();
    };
    const onTouchMove = (event: TouchEvent) => {
      const origin = pointerOriginRef.current;
      // Synthetic `touchmove` events (a bare `Event`, as the drag tests
      // dispatch on a row) carry no `touches`; they must not throw out of a
      // passive listener on the shared scroll body.
      const point = event.touches?.[0];
      if (!origin || !point) return;
      // Below the tap slop this is still a finger resting on a row, not a
      // scroll: a jittery tap must not claim the clamp as its own position.
      if (Math.abs(point.clientX - origin.x) > 8 || Math.abs(point.clientY - origin.y) > 8) {
        movedByReader();
      }
    };
    const onKeyDown = () => {
      movedByReader();
    };
    let lastWrite = 0;
    const write = (force: boolean) => {
      const now = performance.now();
      if (!force && now - lastWrite < 300) return;
      lastWrite = now;
      try {
        sessionStorage.setItem(scrollKey, String(lastTopRef.current));
      } catch {
        // No storage: nothing to remember.
      }
    };
    const save = () => {
      if (!settledRef.current) return;
      // A scroll that arrives while a pointer is down is the reader's: the
      // browser only scrolls a touched body after the drag has passed the tap
      // slop, and a mouse drag (a scrollbar) is the same story.
      if (pointerOriginRef.current) movedByReader();
      const top = node.scrollTop;
      // A content swap — the loading skeleton replaced by the rows — collapses
      // the body under the offset, and the browser clamps it to the top with a
      // scroll event of its own. Nothing the reader did moved it there, so the
      // clamp is the layout's, not a position: recording it writes "0" over
      // the mark the restore is still trying to reach (the search-state Back
      // path), and spending the restore freezes the list at the top. Re-arm
      // instead and let the growth retry put the reader back.
      if (top === 0 && lastTopRef.current > 0 && !readerMovedRef.current) {
        settledRef.current = false;
        recordedRef.current = false;
        restore();
        return;
      }
      recordedRef.current = true;
      // Read the node here, while the scroll is real, and never again: an
      // unmount-time reread sees the route change's clamp instead.
      lastTopRef.current = top;
      write(false);
    };
    node.addEventListener("pointerdown", onPointerDown, { passive: true });
    node.addEventListener("pointerup", onPointerUp, { passive: true });
    node.addEventListener("pointercancel", onPointerCancel, { passive: true });
    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("touchmove", onTouchMove, { passive: true });
    node.addEventListener("keydown", onKeyDown);
    node.addEventListener("scroll", save, { passive: true });
    return () => {
      // The unmount is the last chance to record the tail of the throttle
      // window: write the offset the scroll handler last saw, not a fresh read
      // of a container the route change has already collapsed. Do not spend it
      // on a position the restore never reached.
      if (recordedRef.current) write(true);
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("pointerup", onPointerUp);
      node.removeEventListener("pointercancel", onPointerCancel);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("touchmove", onTouchMove);
      node.removeEventListener("keydown", onKeyDown);
      node.removeEventListener("scroll", save);
    };
  }, [restore, scrollKey]);

  // Restore, and retry whenever the caller's signal moves.
  useLayoutEffect(() => {
    restore();
  }, [restore, scrollWhen]);

  // The rows' count can be final before their heights are: settled rows and a
  // wrapping status line grow the content in place, after the clamped restore
  // already ran, and `scrollWhen` never moves again. Watch the children's
  // wrapper — the scroll container's own box is fixed by its parents, so an
  // observer on it would never fire. The retry is bounded by the reachability
  // rule (`settled` stops it) and by the reader: a pointer or wheel settles the
  // body, so growth never yanks someone who has chosen a new position.
  useLayoutEffect(() => {
    if (!scrollKey) return;
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      restore();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [restore, scrollKey]);

  return (
    <div
      ref={ref}
      data-phone-scroll={scrollKey ? "" : undefined}
      className={[
        "flex-1 min-h-0 overflow-y-auto overflow-x-hidden kin-scroll phone-footer-clearance [overflow-anchor:none]",
        className,
      ].join(" ")}
    >
      {/* Layout-transparent block: full width, no margin or padding, so the
          rows keep the exact geometry they had as direct children. It exists
          only to give the growth observer a box inside the scroll node. */}
      <div ref={contentRef}>{children}</div>
    </div>
  );
}

/**
 * A titled group of rows — the phone's one list shape.
 *
 * The heading lives *outside* the card and the card is inset, which is the iOS
 * grouped-list arrangement. The alternative (a heading inside a bordered box,
 * which the console used) makes the heading compete with the first row for the
 * same frame.
 */
export function MobileSection({
  title,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={["mt-5 first:mt-1", className].join(" ")}>
      {title || action ? (
        <div className="flex min-h-8 items-center justify-between gap-2 px-4 pb-1.5 pt-1">
          {typeof title === "string" ? (
            <h2 className="min-w-0 truncate text-strong font-medium text-kin-muted">{title}</h2>
          ) : (
            <div className="min-w-0">{title}</div>
          )}
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * The card itself: one surface, and the only place a hairline is drawn between
 * rows. Rows are direct children so `divide-y` can own the separators — a row
 * never has to know whether it is first, which is what makes them reorderable.
 *
 * `mx-4`: the same gutter as the section heading, so the left edge of a
 * heading, its card and the row titles inside it form one line.
 */
export function MobileCard({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={[
        "kin-card mx-4 overflow-hidden rounded-2xl",
        "[&>*+*]:border-t [&>*+*]:border-[var(--kin-hairline)]",
        className,
      ].join(" ")}
    >
      {children}
    </div>
  );
}

export type MobileRowProps = {
  leading?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  /** Draws the drill-in chevron after `trailing`. */
  chevron?: boolean;
  disabled?: boolean;
  /** Marks the current destination in a list of places. */
  selected?: boolean;
  className?: string;
};

/**
 * One row: 52px tall, 16px gutters, a 16px medium title and a 12px muted
 * second line. The title truncates and the trailing cluster does not — a
 * trailing control that shrinks is a control that disappears behind a long
 * project name, which is the bug this row shape exists to prevent.
 */
export function MobileRow({
  leading,
  title,
  detail,
  trailing,
  onClick,
  chevron,
  disabled,
  selected,
  className = "",
}: MobileRowProps) {
  const body = (
    <>
      {leading ? <span className="flex shrink-0 items-center">{leading}</span> : null}
      <span className="min-w-0 flex-1">
        <span
          className={[
            "block truncate text-subtitle leading-ui",
            selected ? "font-semibold text-kin-text" : "font-medium text-kin-text",
          ].join(" ")}
        >
          {title}
        </span>
        {detail ? (
          <span className="mt-0.5 block truncate text-caption leading-ui text-kin-muted">
            {detail}
          </span>
        ) : null}
      </span>
      {trailing ? (
        <span className="flex shrink-0 items-center gap-1.5 text-caption text-kin-muted">
          {trailing}
        </span>
      ) : null}
      {chevron ? <MobileChevron /> : null}
    </>
  );
  const shared = [
    "flex w-full min-h-[52px] items-center gap-3 px-4 py-2.5 text-left",
    disabled ? "opacity-50" : "kin-row-press",
    selected ? "bg-[var(--kin-fill)]" : "",
    className,
  ].join(" ");
  if (!onClick) return <div className={shared}>{body}</div>;
  return (
    /* eslint-disable-next-line kin/no-raw-button --
       A row is a full-width navigation target, not a button-shaped control;
       the card's dividers and the 52px row rhythm are the design here, and
       the design system has no row primitive. */
    <button type="button" onClick={onClick} disabled={disabled} className={shared}>
      {body}
    </button>
  );
}

/**
 * The empty state for a list. Centred, one sentence and one hint — the console
 * used to render a bare muted line, which on a full-height phone screen reads
 * as "still loading" rather than "nothing here".
 */
export function MobileEmpty({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-8 py-16 text-center">
      {icon ? <div className="mb-3 text-kin-muted opacity-70">{icon}</div> : null}
      <p className="text-subtitle font-medium text-kin-text">{title}</p>
      {hint ? (
        <p className="mt-1.5 max-w-[18rem] text-body leading-prose text-kin-muted">{hint}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
