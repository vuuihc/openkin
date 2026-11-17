/**
 * Shimmer skeleton loaders matched to the console's list and page row geometry.
 *
 * Replaces raw `Loading…` text and unshaped pulse blocks so cold mounts hold
 * the layout structure instead of flashing blank space. Every container carries
 * `aria-live="polite"`, `aria-busy="true"`, and an `sr-only` label so screen
 * readers and tests receive the same loading announcement.
 */

const SESSION_TITLE_WIDTHS = ["w-3/5", "w-3/4", "w-1/2", "w-2/3", "w-3/5", "w-1/2"] as const;

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
      aria-live="polite"
      aria-busy="true"
      data-testid="session-list-skeleton"
      className="select-none py-2"
    >
      <span className="sr-only">{label}</span>
      <div className={["flex items-center gap-2 pb-1.5 pt-2", gutter].join(" ")}>
        <div className="h-3.5 w-3.5 rounded-full kin-skeleton" aria-hidden />
        <div className="h-3 w-20 rounded kin-skeleton" aria-hidden />
      </div>
      {[0, 1].map((groupIndex) => (
        <div key={groupIndex} className={shell === "sidebar" ? "pl-4" : undefined}>
          <div className={["flex items-center gap-2 py-2", gutter].join(" ")}>
            <div className="h-3 w-24 rounded kin-skeleton" aria-hidden />
          </div>
          {bucketRows.map((rowIndex) => {
            const width =
              SESSION_TITLE_WIDTHS[(groupIndex * 3 + rowIndex) % SESSION_TITLE_WIDTHS.length];
            return (
              <div
                key={rowIndex}
                className={["flex min-h-11 items-center gap-2.5 py-2.5", gutter].join(" ")}
              >
                <span className="w-2 flex-none" aria-hidden />
                <div className="h-5 w-5 flex-none rounded-full kin-skeleton" aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className={["h-3.5 rounded kin-skeleton", width].join(" ")} aria-hidden />
                </div>
                <div className="h-3 w-8 flex-none rounded kin-skeleton" aria-hidden />
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

export function PageListSkeleton({ rows = 4, label }: { rows?: number; label: string }) {
  return (
    <div
      aria-live="polite"
      aria-busy="true"
      data-testid="page-list-skeleton"
      className="flex flex-col gap-2.5 py-1"
    >
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => {
        const titleWidth = PAGE_TITLE_WIDTHS[index % PAGE_TITLE_WIDTHS.length];
        const detailWidth = PAGE_DETAIL_WIDTHS[index % PAGE_DETAIL_WIDTHS.length];
        return (
          <div
            key={index}
            className="kin-skeleton-card flex items-center justify-between gap-3 px-4 py-3.5"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <div className={["h-4 rounded kin-skeleton", titleWidth].join(" ")} aria-hidden />
              <div className={["h-3 rounded kin-skeleton", detailWidth].join(" ")} aria-hidden />
            </div>
            <div className="h-3 w-12 flex-none rounded kin-skeleton" aria-hidden />
          </div>
        );
      })}
    </div>
  );
}
