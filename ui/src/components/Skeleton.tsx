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

const SESSION_TITLE_WIDTHS = ["w-3/5", "w-3/4", "w-1/2", "w-2/3", "w-3/5", "w-1/2"] as const;

/**
 * Geometry-matched shimmer skeleton for the conversation list (`sidebar` or
 * `page` shell) so cold mounts hold row height without flashing blank space.
 */
export function SessionListSkeleton({
  shell,
  label,
}: {
  shell: "sidebar" | "page";
  label: string;
}) {
  const gutter = shell === "sidebar" ? "px-2" : "px-4";
  const bucketRows = [0, 1, 2];

  return (
    <div
      role="status"
      aria-label={label}
      data-testid="session-list-skeleton"
      className="select-none py-2"
    >
      <div className={["flex items-center gap-2 pb-1.5 pt-2", gutter].join(" ")} aria-hidden>
        <div className="h-3.5 w-3.5 rounded-full kin-skeleton" />
        <div className="h-3 w-20 rounded kin-skeleton" />
      </div>
      {[0, 1].map((groupIndex) => (
        <div key={groupIndex} className={shell === "sidebar" ? "pl-4" : undefined} aria-hidden>
          <div className={["flex items-center gap-2 py-2", gutter].join(" ")}>
            <div className="h-3 w-24 rounded kin-skeleton" />
          </div>
          {bucketRows.map((rowIndex) => {
            const width =
              SESSION_TITLE_WIDTHS[(groupIndex * 3 + rowIndex) % SESSION_TITLE_WIDTHS.length];
            return (
              <div
                key={rowIndex}
                className={["flex min-h-11 items-center gap-2.5 py-2.5", gutter].join(" ")}
              >
                <span className="w-2 flex-none" />
                <div className="h-5 w-5 flex-none rounded-full kin-skeleton" />
                <div className="min-w-0 flex-1">
                  <div className={["h-3.5 rounded kin-skeleton", width].join(" ")} />
                </div>
                <div className="h-3 w-8 flex-none rounded kin-skeleton" />
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

const PAGE_TITLE_WIDTHS = ["w-1/2", "w-2/5", "w-3/5", "w-1/3"] as const;
const PAGE_DETAIL_WIDTHS = ["w-3/4", "w-2/3", "w-1/2", "w-2/3"] as const;

/**
 * Geometry-matched shimmer skeleton for collection pages:
 * - `rows`: flat borderless rows with trailing chevron (matches `/projects`).
 * - `cards`: elevated rounded cards (matches `/routines`).
 */
export function PageListSkeleton({
  rows = 4,
  label,
  variant = "cards",
}: {
  rows?: number;
  label: string;
  variant?: "rows" | "cards";
}) {
  return (
    <div
      role="status"
      aria-label={label}
      data-testid="page-list-skeleton"
      className={variant === "rows" ? "flex flex-col" : "flex flex-col gap-2.5 py-1"}
    >
      {Array.from({ length: rows }, (_, index) => {
        const titleWidth = PAGE_TITLE_WIDTHS[index % PAGE_TITLE_WIDTHS.length];
        const detailWidth = PAGE_DETAIL_WIDTHS[index % PAGE_DETAIL_WIDTHS.length];
        if (variant === "rows") {
          return (
            <div
              key={index}
              className="-mx-2 flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-2.5"
              aria-hidden
            >
              <div className="min-w-0 flex-1 space-y-1.5">
                <div className={["h-4 rounded kin-skeleton", titleWidth].join(" ")} />
                <div className={["h-3 rounded kin-skeleton", detailWidth].join(" ")} />
              </div>
              <div className="h-3.5 w-3.5 flex-none rounded kin-skeleton" />
            </div>
          );
        }
        return (
          <div
            key={index}
            className="kin-skeleton-card flex items-center justify-between gap-3 px-4 py-3.5"
            aria-hidden
          >
            <div className="min-w-0 flex-1 space-y-2">
              <div className={["h-4 rounded kin-skeleton", titleWidth].join(" ")} />
              <div className={["h-3 rounded kin-skeleton", detailWidth].join(" ")} />
            </div>
            <div className="h-3 w-12 flex-none rounded kin-skeleton" />
          </div>
        );
      })}
    </div>
  );
}

export function ApprovalListSkeleton({ count = 2 }: { count?: number }) {
  return (
    <ul className="space-y-4" role="status" aria-label={t("common.loading")}>
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
