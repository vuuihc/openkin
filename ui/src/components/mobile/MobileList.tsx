import { useLayoutEffect, useRef, type ReactNode } from "react";
import { MobileChevron } from "./MobileHeader";

/**
 * The scroll body of a phone screen.
 *
 * `overflow-y-auto` on the page rather than on the document: the shell is a
 * fixed-height column, and a page that scrolled the document would take the
 * header and the footer with it.
 *
 * Nothing is reserved for a floating pill here. The phone list page's footer
 * is a flex sibling of this container (KIN-CONTINUE-002), so the scroll body
 * ends where the footer begins and the last row is never under it.
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
   * rows changed; this is that signal.
   */
  scrollWhen?: unknown;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const savedRef = useRef(0);
  const settledRef = useRef(true);
  const recordedRef = useRef(false);

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

    // A reader who starts scrolling while the data is still arriving has
    // chosen a new position; stop restoring rather than fight them. The touch
    // alone does not start recording: a tap that never scrolls must not
    // replace the remembered place with the top.
    const yieldToReader = () => {
      settledRef.current = true;
    };
    let lastWrite = 0;
    const write = (force: boolean) => {
      const now = performance.now();
      if (!force && now - lastWrite < 300) return;
      lastWrite = now;
      try {
        sessionStorage.setItem(scrollKey, String(node.scrollTop));
      } catch {
        // No storage: nothing to remember.
      }
    };
    const save = () => {
      if (!settledRef.current) return;
      recordedRef.current = true;
      write(false);
    };
    node.addEventListener("pointerdown", yieldToReader, { passive: true });
    node.addEventListener("wheel", yieldToReader, { passive: true });
    node.addEventListener("scroll", save, { passive: true });
    return () => {
      // The unmount is the last chance to record; do not spend it on a
      // position the restore never reached.
      if (recordedRef.current) write(true);
      node.removeEventListener("pointerdown", yieldToReader);
      node.removeEventListener("wheel", yieldToReader);
      node.removeEventListener("scroll", save);
    };
  }, [scrollKey]);

  // Restore, and retry whenever the content version moves. `settled` is only
  // spent when the saved offset is actually reachable: setting `scrollTop`
  // short of the content clamps it, and settling there would freeze a half
  // restored position.
  useLayoutEffect(() => {
    if (!scrollKey || settledRef.current) return;
    const node = ref.current;
    if (!node) return;
    node.scrollTop = savedRef.current;
    const reachable = savedRef.current <= Math.max(0, node.scrollHeight - node.clientHeight);
    if (reachable) {
      settledRef.current = true;
      // The saved value is on screen again; recording it back is a no-op.
      recordedRef.current = true;
    }
  }, [scrollKey, scrollWhen]);

  return (
    <div
      ref={ref}
      data-phone-scroll={scrollKey ? "" : undefined}
      className={["flex-1 min-h-0 overflow-y-auto kin-scroll", className].join(" ")}
    >
      {children}
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
