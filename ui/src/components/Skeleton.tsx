/** Shared skeleton building blocks for loading states (no layout jump). */
import { t } from "../i18n";

export function SkeletonLine({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-kin-fill-strong ${className}`} aria-hidden />;
}

export function SkeletonCard({ lines = 2 }: { lines?: number }) {
  return (
    <div className="rounded-xl bg-kin-elevated px-4 py-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <SkeletonLine className="h-4 w-2/3" />
        <SkeletonLine className="h-5 w-16 shrink-0" />
      </div>
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonLine key={i} className={`h-3 ${i === 0 ? "w-1/2" : "w-1/3"}`} />
      ))}
    </div>
  );
}

export function TaskListSkeleton({ count = 4 }: { count?: number }) {
  return (
    <ul className="space-y-2" role="status" aria-label={t("common.loading")}>
      {Array.from({ length: count }).map((_, i) => (
        <li key={i}>
          <SkeletonCard lines={2} />
        </li>
      ))}
    </ul>
  );
}

/**
 * The tasks *table*'s placeholder.
 *
 * `TaskListSkeleton` draws cards, and the tasks page stopped being a list of
 * cards: what arrives is a bordered table of rows, so the card skeleton made
 * every row jump as the data landed. The two column shapes a phone shows —
 * title and status chip — are the two this draws, at the row's height.
 */
export function TaskTableSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div
      className="overflow-hidden rounded-xl border border-[var(--kin-hairline)]"
      role="status"
      aria-label={t("common.loading")}
    >
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-[var(--kin-hairline)] px-3 py-3.5 last:border-0"
        >
          <SkeletonLine className="h-4 flex-1" />
          <SkeletonLine className="h-5 w-14 shrink-0 rounded" />
        </div>
      ))}
    </div>
  );
}

/** Hint shown when a request has been pending longer than ~10s (slow Funnel/link). */
export function SlowConnectHint({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p
      className="text-body leading-4 text-kin-orange-ink/90 rounded-lg border border-kin-orange/30 bg-kin-orange/10 px-3 py-2"
      role="status"
    >
      {t("common.stillConnecting")}
    </p>
  );
}
