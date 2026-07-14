/** Shared skeleton building blocks for loading states (no layout jump). */

export function SkeletonLine({ className = "" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-md bg-zinc-800/80 ${className}`}
      aria-hidden
    />
  );
}

export function SkeletonCard({ lines = 2 }: { lines?: number }) {
  return (
    <div className="rounded-xl border border-surface-border bg-surface-raised px-4 py-3 space-y-2">
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
        <li
          key={i}
          className="rounded-2xl border border-surface-border bg-surface-raised overflow-hidden"
        >
          <div className="border-b border-surface-border px-4 py-3 space-y-2">
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

export function PageHeaderSkeleton({ title }: { title: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h1 className="text-xl font-semibold text-zinc-50">{title}</h1>
      <SkeletonLine className="h-9 w-24" />
    </div>
  );
}

/** Hint shown when a request has been pending longer than ~10s (slow Funnel/link). */
export function SlowConnectHint({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p
      className="text-xs text-amber-400/90 rounded-lg border border-amber-900/40 bg-amber-950/30 px-3 py-2"
      role="status"
    >
      Still connecting — your link may be slow.
    </p>
  );
}
