import type { PulseDay } from "../../api/client";
import { HEAT_CELL_RING, HEAT_RAMP } from "../../design/heat";
import { useT } from "../../i18n/react";

type Props = {
  days: PulseDay[] | undefined;
  title: string;
  /** max cells to show from the end (default 90) */
  max?: number;
};

/**
 * GitHub-like discrete levels. The ramp is solid colours rather than a token:
 * see `design/heat.ts` for why.
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

/**
 * Compact contribution-style heatmap for session or commit activity.
 */
export default function Heatmap({ days, title, max = 90 }: Props) {
  const tr = useT();
  const data = (days ?? []).slice(-max);
  const maxCount = data.reduce((m, d) => Math.max(m, d.count), 0);
  const total = data.reduce((s, d) => s + d.count, 0);
  if (data.length === 0) {
    return <div className="text-body text-kin-secondary">{title}: —</div>;
  }

  // ~7 rows like GitHub weeks; columns = ceil(n/7)
  const cols = Math.ceil(data.length / 7);

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="text-caption font-medium uppercase tracking-label text-kin-secondary">
          {title}
        </div>
        <div className="text-caption text-kin-muted tabular-nums">
          {tr("common.maxPerDay", { total, max: maxCount || 0 })}
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
                className="rounded-sm"
                style={{
                  width: 10,
                  height: 10,
                  background: HEAT_RAMP[lv],
                  boxShadow: lv > 0 ? HEAT_CELL_RING : undefined,
                }}
              />
            );
          })}
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-1 text-micro text-kin-muted">
        <span>{tr("common.less")}</span>
        {HEAT_RAMP.map((c, i) => (
          <span
            key={i}
            className="inline-block rounded-sm"
            style={{ width: 10, height: 10, background: c }}
          />
        ))}
        <span>{tr("common.more")}</span>
        <span className="ml-auto tabular-nums opacity-70">
          {tr("common.weeks", { count: cols })}
        </span>
      </div>
    </div>
  );
}
