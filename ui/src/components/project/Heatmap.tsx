import type { PulseDay } from "../../api/client";

type Props = {
  days: PulseDay[] | undefined;
  title: string;
  /** max cells to show from the end (default 90) */
  max?: number;
};

/**
 * GitHub-like discrete levels. Use solid colors (color-mix often looks flat
 * when CSS vars resolve poorly).
 */
function level(count: number, maxCount: number): number {
  if (count <= 0) return 0;
  if (maxCount <= 1) return count >= 1 ? 2 : 0;
  // Absolute-ish steps first so sparse activity still lights up.
  if (count === 1) return 1;
  if (count === 2) return 2;
  if (count <= 4) return 3;
  // Relative boost when window is dense.
  const r = count / maxCount;
  if (r >= 0.75) return 4;
  return 3;
}

// Dark-theme greens that read clearly on kin panels.
const COLORS_DARK = [
  "#2a2b30", // empty
  "#0e4429",
  "#006d32",
  "#26a641",
  "#39d353",
];

/**
 * Compact contribution-style heatmap for session or commit activity.
 */
export default function Heatmap({ days, title, max = 90 }: Props) {
  const data = (days ?? []).slice(-max);
  const maxCount = data.reduce((m, d) => Math.max(m, d.count), 0);
  const total = data.reduce((s, d) => s + d.count, 0);
  if (data.length === 0) {
    return (
      <div className="text-[12px] text-kin-secondary">
        {title}: —
      </div>
    );
  }

  // ~7 rows like GitHub weeks; columns = ceil(n/7)
  const cols = Math.ceil(data.length / 7);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="text-[11.5px] font-medium uppercase tracking-wide text-kin-secondary">
          {title}
        </div>
        <div className="text-[11px] text-kin-muted tabular-nums">
          {total} · max {maxCount || 0}/day
        </div>
      </div>
      <div className="overflow-x-auto kin-scroll">
        <div
          className="inline-grid gap-[3px]"
          style={{
            gridTemplateRows: "repeat(7, 10px)",
            gridAutoFlow: "column",
            gridAutoColumns: "10px",
          }}
        >
          {data.map((d) => {
            const lv = level(d.count, maxCount);
            return (
              <div
                key={d.date}
                title={`${d.date}: ${d.count}`}
                className="rounded-[2px]"
                style={{
                  width: 10,
                  height: 10,
                  background: COLORS_DARK[lv],
                  boxShadow:
                    lv > 0 ? "inset 0 0 0 1px rgba(255,255,255,0.06)" : undefined,
                }}
              />
            );
          })}
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-1 text-[10px] text-kin-muted">
        <span>Less</span>
        {COLORS_DARK.map((c, i) => (
          <span
            key={i}
            className="inline-block rounded-[2px]"
            style={{ width: 10, height: 10, background: c }}
          />
        ))}
        <span>More</span>
        <span className="ml-auto tabular-nums opacity-70">{cols}w</span>
      </div>
    </div>
  );
}
