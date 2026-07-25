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

type Props = {
  usage: TaskUsage | null;
  loading: boolean;
  /** strip = chat-column chip; card = side-rail panel (Codex-style). */
  variant?: "strip" | "card";
  className?: string;
};

/**
 * Task usage summary. Default strip sits above the transcript;
 * card variant docks into the session side rail.
 */
export default function TaskUsageSummary({
  usage,
  loading,
  variant = "strip",
  className,
}: Props) {
  const tr = useT();
  const [open, setOpen] = useState(false);
  const detailsID = useId();
  const isCard = variant === "card";

  if (loading) {
    if (isCard) {
      return (
        <div
          className={[
            "rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated p-3",
            className ?? "",
          ].join(" ")}
          aria-label={tr("usage.loading")}
        >
          <div className="h-4 w-20 animate-pulse rounded bg-[var(--kin-fill)]" />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="h-12 animate-pulse rounded-lg bg-[var(--kin-fill)]" />
            <div className="h-12 animate-pulse rounded-lg bg-[var(--kin-fill)]" />
          </div>
        </div>
      );
    }
    return (
      <div
        className={["mx-auto max-w-[720px] px-4 sm:px-7 pt-2", className ?? ""].join(" ")}
        aria-label={tr("usage.loading")}
      >
        <div className="h-8 animate-pulse rounded-lg bg-[var(--kin-fill)]" />
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

  const details = (
    <div className="space-y-2.5">
      <dl className="grid grid-cols-2 gap-1.5">
        <Metric
          label={tr("usage.tokens")}
          value={formatTokenCount(usage.tokens_in + usage.tokens_out)}
          dense={isCard}
        />
        <Metric
          label={tr("usage.spend")}
          value={
            costBadge
              ? `${formatCost(usage.cost_usd)} (${costBadge.label})`
              : formatCost(usage.cost_usd)
          }
          title={costBadge?.title}
          dense={isCard}
        />
        <Metric
          label={tr("usage.inputOutput")}
          value={`${formatTokenCount(usage.tokens_in)} / ${formatTokenCount(usage.tokens_out)}`}
          dense={isCard}
        />
        <Metric
          label={tr("usage.cacheHitRate")}
          value={cacheRateLabel(state, usage.cache_hit_rate ?? null)}
          dense={isCard}
        />
      </dl>
      <p className="text-[10.5px] leading-snug text-kin-muted" role="status">
        {statusText}
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
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
  );

  if (isCard) {
    return (
      <section
        className={[
          "rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated overflow-hidden",
          className ?? "",
        ].join(" ")}
        aria-label={tr("usage.taskSummary")}
      >
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--kin-hairline)]">
          <div className="min-w-0">
            <div className="text-[10.5px] font-semibold uppercase tracking-wide text-kin-muted">
              {tr("usage.taskSummary")}
            </div>
            <div className="mt-0.5 truncate text-[12.5px] tabular-nums text-kin-secondary">
              <span className="font-medium text-kin-text">{totalTokens}</span>
              <span className="text-kin-muted"> · </span>
              <span>{spend}</span>
              {costBadge ? (
                <span
                  className="ml-1 text-[10px] font-semibold uppercase tracking-wide text-kin-muted"
                  title={costBadge.title}
                >
                  ({costBadge.label})
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsID}
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 rounded-md px-1.5 py-1 text-[11px] font-medium text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-secondary transition-colors"
          >
            {open ? tr("usage.hideDetails") : tr("usage.showDetails")}
          </button>
        </div>
        <div className="px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] tabular-nums text-kin-secondary">
            {cacheHit && cacheHit !== "—" ? (
              <span>
                {tr("usage.cacheHitRate")}:{" "}
                <span className="font-medium text-kin-text">{cacheHit}</span>
              </span>
            ) : (
              <span className="text-kin-muted">{statusText}</span>
            )}
          </div>
          {open && (
            <div id={detailsID} className="mt-2.5 pt-2.5 border-t border-[var(--kin-hairline)]">
              {details}
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      className={["mx-auto max-w-[720px] px-4 sm:px-7 pt-2", className ?? ""].join(" ")}
      aria-label={tr("usage.taskSummary")}
    >
      <div className="rounded-xl border border-[var(--kin-hairline)] bg-kin-elevated overflow-hidden">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailsID}
          onClick={() => setOpen((value) => !value)}
          className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--kin-fill)]/60 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-kin-blue"
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
            {details}
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
  dense,
}: {
  label: string;
  value: string;
  title?: string;
  dense?: boolean;
}) {
  return (
    <div
      className={[
        "min-w-0 rounded-lg bg-[var(--kin-fill)]",
        dense ? "px-2 py-1.5" : "px-2.5 py-2",
      ].join(" ")}
      title={title}
    >
      <dt className="text-[10px] font-semibold uppercase tracking-wide text-kin-muted">
        {label}
      </dt>
      <dd
        className={[
          "mt-0.5 truncate font-semibold tabular-nums",
          dense ? "text-[13px]" : "text-[15px]",
        ].join(" ")}
      >
        {value}
      </dd>
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
