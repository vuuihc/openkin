import { useId, useState } from "react";
import { formatCost, type TaskUsage } from "../../api/client";
import { useT } from "../../i18n/react";
import {
  cacheCoverageLabel,
  cacheRateLabel,
  cacheState,
  costSourceLabelKey,
  formatTokenCount,
  primaryCostSource,
} from "../../lib/usage";

type Props = { usage: TaskUsage | null; loading: boolean };

/**
 * Compact task usage strip. Collapsed by default — one summary row;
 * expand for the metric grid + cache/request details.
 */
export default function TaskUsageSummary({ usage, loading }: Props) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const detailsID = useId();
  if (loading) {
    return (
      <div
        className="mx-auto max-w-[720px] px-4 sm:px-7 pt-2"
        aria-label={tr("usage.loading")}
      >
        <div className="h-9 animate-pulse rounded-lg bg-[var(--kin-fill)]" />
      </div>
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

  const totalTokens = formatTokenCount(usage.tokens_in + usage.tokens_out);
  const spend = formatCost(usage.cost_usd);
  const cacheHit = cacheRateLabel(state, usage.cache_hit_rate ?? null);
  const costSource = primaryCostSource(usage.cost_source_subtotals);
  const costLabelKey = costSourceLabelKey(costSource);
  const costBadge =
    costLabelKey && usage.cost_usd != null
      ? {
          label:
            costLabelKey === "costEstimated"
              ? tr("usage.costEstimated")
              : tr("usage.costProvider"),
          title:
            costSource === "price_table"
              ? tr("usage.costEstimatedHint")
              : tr("usage.costProviderHint"),
        }
      : null;

  return (
    <section
      className="mx-auto max-w-[720px] px-4 sm:px-7 pt-2"
      aria-label={tr("usage.taskSummary")}
    >
      <div className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated overflow-hidden">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsID}
          onClick={() => setOpen((value) => !value)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--kin-fill)]/60 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-kin-blue"
        >
          <span className="text-[11px] font-semibold uppercase tracking-wide text-kin-muted shrink-0">
            {tr("usage.taskSummary")}
          </span>
          <span className="flex-1 min-w-0 truncate text-[12.5px] tabular-nums text-kin-secondary">
            <span className="text-kin-text font-medium">{totalTokens}</span>
            <span className="text-kin-muted"> · </span>
            <span>{spend}</span>
            {costBadge ? (
              <span
                className="ml-1 align-middle text-[10px] font-semibold uppercase tracking-wide text-kin-muted"
                title={costBadge.title}
              >
                ({costBadge.label})
              </span>
            ) : null}
            {cacheHit && cacheHit !== "—" ? (
              <>
                <span className="text-kin-muted"> · </span>
                <span>
                  {tr("usage.cacheHitRate")}: {cacheHit}
                </span>
              </>
            ) : null}
          </span>
          <span className="shrink-0 text-[11.5px] font-medium text-kin-muted">
            {open ? tr("usage.hideDetails") : tr("usage.showDetails")}
          </span>
        </button>

        {open && (
          <div
            id={detailsID}
            className="border-t border-[var(--kin-hairline)] px-3 py-3 space-y-3"
          >
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric
                label={tr("usage.tokens")}
                value={formatTokenCount(usage.tokens_in + usage.tokens_out)}
              />
              <Metric
                label={tr("usage.inputOutput")}
                value={`${formatTokenCount(usage.tokens_in)} / ${formatTokenCount(usage.tokens_out)}`}
              />
              <Metric
                label={tr("usage.cacheHitRate")}
                value={cacheRateLabel(state, usage.cache_hit_rate ?? null)}
              />
              <Metric
                label={tr("usage.spend")}
                value={
                  costBadge
                    ? `${formatCost(usage.cost_usd)} (${costBadge.label})`
                    : formatCost(usage.cost_usd)
                }
                title={costBadge?.title}
              />
            </dl>
            <p className="text-[11px] text-kin-muted" role="status">
              {statusText}
            </p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] sm:grid-cols-4">
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
          </div>
        )}
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg bg-[var(--kin-fill)] px-2.5 py-2" title={title}>
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
