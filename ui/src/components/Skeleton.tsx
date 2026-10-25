/** Shared skeleton building blocks for loading states (no layout jump). */

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
    <ul className="space-y-2" role="status" aria-label="Loading tasks">
      {Array.from({ length: count }).map((_, i) => (
        <li key={i}>
          <SkeletonCard lines={2} />
        </li>
      ))}
    </ul>
  );
}

export function ApprovalListSkeleton({ count = 2 }: { count?: number }) {
  return (
    <ul className="space-y-4" role="status" aria-label="Loading approvals">
      {Array.from({ length: count }).map((_, i) => (
        <li key={i} className="rounded-2xl bg-kin-elevated overflow-hidden">
          <div className="border-b border-kin-hairline-strong px-4 py-3 space-y-2">
            <SkeletonLine className="h-3 w-24" />
            <SkeletonLine className="h-5 w-40" />
          </div>
          <div className="px-4 py-3 space-y-2">
            <SkeletonLine className="h-3 w-16" />
            <SkeletonLine className="h-20 w-full" />
          </div>
          <div className="flex gap-3 p-4 pt-0">
            <SkeletonLine className="h-12 flex-1 rounded-xl" />
            <SkeletonLine className="h-12 flex-1 rounded-xl" />
          </div>
        </li>
      ))}
    </ul>
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
      Still connecting — your link may be slow.
    </p>
  );
}
