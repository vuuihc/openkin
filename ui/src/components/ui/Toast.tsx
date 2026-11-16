import type { ReactNode } from "react";

/** The three things a toast can be: neutral, a completed action, a failure. */
export type ToastTone = "info" | "success" | "error";

export type ToastItem = {
  id: string;
  message: ReactNode;
  /** Defaults to `info`. */
  tone?: ToastTone;
};

export type ToastProps = {
  toasts: ToastItem[];
  /** Called with the toast id; the caller owns removal. */
  onDismiss: (id: string) => void;
  /**
   * Accessible name of the dismiss control (caller's i18n string). The visible
   * glyph stays a decorative ×.
   */
  dismissLabel: string;
  /** Placement only — where the caller needs the strip to sit. */
  className?: string;
};

/**
 * Solid opaque surfaces only. A toast floats over whatever is scrolling behind
 * it, so a tint has no fixed backdrop to be measured against; the tone is
 * carried by the border and the ink, over the same elevated surface.
 */
const TONE: Record<ToastTone, string> = {
  info: "border-transparent bg-kin-elevated text-kin-text",
  success: "border-kin-green/50 bg-kin-elevated text-kin-green-ink",
  error: "border-kin-red/50 bg-kin-elevated text-kin-red-ink",
};

/**
 * One strip of short-lived results, floating at the bottom of the current page.
 *
 * This is the presentation half of the toast contract: the caller owns the
 * list, the order, the lifetime and the removal, exactly as `ToastHost` owns
 * them today. The component runs no timer of its own — auto-dismiss belongs to
 * whoever owns the queue, and a second clock here would keep shouting about a
 * row the caller had already dropped. A dismiss reports one id and changes
 * nothing else, so a caller that ignores the callback simply keeps the toast.
 *
 * Every toast is its own polite status region, so one insertion is one
 * announcement, and removing a neighbour does not re-read the remaining rows.
 * The strip deliberately adds no second live region around them: nested live
 * regions make some readers speak the same message twice. An empty list
 * returns `null` rather than an empty region — there is nothing to announce,
 * and whether a freshly inserted toast needs a persistent announcer is the
 * migration round's call, verified on a real reader.
 *
 * The strip sits on the console's shared overlay layer (`z-50`, the same rung
 * `Popover` uses) instead of minting another one; the round that replaces
 * `ToastHost` decides whether toasts must outrank popovers. The wrapper lets
 * pointer events through and each card takes them back, so the gaps between
 * toasts do not swallow taps meant for the page underneath.
 */
export default function Toast({ toasts, onDismiss, dismissLabel, className }: ToastProps) {
  if (!toasts.length) return null;

  return (
    <div
      className={[
        "fixed bottom-0 inset-x-0 z-50 flex flex-col items-center gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pointer-events-none",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={[
            "pointer-events-auto w-full max-w-md rounded-xl border px-4 py-3 text-strong leading-5 shadow-e3 flex items-start justify-between gap-3",
            TONE[toast.tone ?? "info"],
          ].join(" ")}
          role="status"
          aria-live="polite"
        >
          <div className="min-w-0 break-words">{toast.message}</div>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            // The floor is the phone's: 44px square on touch, released on a
            // wide screen where the row's visual weight should stay on the
            // message. The focus ring is the console token, drawn outside the
            // glyph so it stays visible against every tone.
            className="shrink-0 min-h-11 min-w-11 sm:min-h-0 -my-2 -mr-2 flex items-center justify-center rounded-lg text-kin-muted hover:text-kin-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kin-focus-ring"
            aria-label={dismissLabel}
          >
            <span aria-hidden>×</span>
          </button>
        </div>
      ))}
    </div>
  );
}
