import { useId, useState } from "react";
import { formatCost, type TaskUsage } from "../../api/client";
import { useT } from "../../i18n/react";
import { cacheCoverageLabel, cacheRateLabel, cacheState, formatTokenCount } from "../../lib/usage";

type Props = { usage: TaskUsage | null; loading: boolean };

export default function TaskUsageSummary({ usage, loading }: Props) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const detailsID = useId();
  if (loading) {
    return (
      <div
        className="h-[72px] animate-pulse rounded-xl bg-[var(--kin-fill)]"
        aria-label={tr("usage.loading")}
      />
    );
  }
  if (!usage) return null;

  const state = cacheState(usage.cache_status, usage.cache_hit_rate ?? null);
  const coverage = cacheCoverageLabel(usage.cache_coverage);
  const cacheTokensKnown = state === "reported" || state === "mixed";
  const statusText =
    state === "unsupported"
      ? tr("usage.cacheUnsupported")
      : state === "unknown"
        ? tr("usage.cacheUnknown")
        : state === "mixed"
          ? tr("usage.cacheMixed")
          : coverage
            ? tr("usage.coverage", { coverage })
            : tr("usage.cacheReported");

  return (
    <section className="mx-auto max-w-[720px] px-4 sm:px-7 pt-3" aria-label={tr("usage.taskSummary")}>
      <div className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated p-3">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label={tr("usage.tokens")} value={formatTokenCount(usage.tokens_in + usage.tokens_out)} />
          <Metric label={tr("usage.inputOutput")} value={`${formatTokenCount(usage.tokens_in)} / ${formatTokenCount(usage.tokens_out)}`} />
          <Metric label={tr("usage.cacheHitRate")} value={cacheRateLabel(state, usage.cache_hit_rate ?? null)} />
          <Metric label={tr("usage.spend")} value={formatCost(usage.cost_usd)} />
        </dl>
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="min-w-0 text-[11px] text-kin-muted" role="status">
            {statusText}
          </p>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsID}
            onClick={() => setOpen((value) => !value)}
            className="shrink-0 rounded-md px-2 py-1 text-[12px] font-medium text-kin-secondary underline-offset-2 hover:text-kin-text hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-kin-blue"
          >
            {open ? tr("usage.hideDetails") : tr("usage.showDetails")}
          </button>
        </div>
        {open && (
          <dl
            id={detailsID}
            className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-[var(--kin-hairline)] pt-3 text-[12px] sm:grid-cols-4"
          >
            <Detail
              label={tr("usage.cacheRead")}
              value={cacheTokensKnown ? formatTokenCount(usage.cache_read_tokens) : "—"}
            />
            <Detail
              label={tr("usage.cacheWrite")}
              value={cacheTokensKnown ? formatTokenCount(usage.cache_write_tokens) : "—"}
            />
            <Detail
              label={tr("usage.reasoningOutput")}
              value={formatTokenCount(usage.reasoning_output_tokens)}
            />
            <Detail label={tr("usage.requests")} value={String(usage.request_count)} />
          </dl>
        )}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-[var(--kin-fill)] px-2.5 py-2">
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-kin-muted">
        {label}
      </dt>
      <dd className="mt-0.5 truncate text-[15px] font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-kin-muted">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
