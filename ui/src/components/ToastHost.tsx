import { useAppStore } from "../store/appStore";

export default function ToastHost() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);

  if (!toasts.length) return null;

  return (
    <div
      className="fixed bottom-0 inset-x-0 z-[60] flex flex-col items-center gap-2 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pointer-events-none"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={[
            // Solid opaque surfaces only — a toast floats over whatever is
            // scrolling behind it, so a tint has no fixed backdrop to be
            // measured against. The tone is carried by the border and the ink.
            "pointer-events-auto w-full max-w-md rounded-xl border px-4 py-3 text-strong leading-5 shadow-e3 flex items-start justify-between gap-3",
            t.tone === "error"
              ? "border-kin-red/50 bg-kin-elevated text-kin-red-ink"
              : "border-transparent bg-kin-elevated text-kin-text",
          ].join(" ")}
          role="status"
        >
          <span className="min-w-0 break-words">{t.message}</span>
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            className="shrink-0 min-h-11 min-w-[44px] -my-2 -mr-2 flex items-center justify-center text-kin-muted hover:text-kin-text"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
