import { useEffect, useMemo, useState } from "react";
import type { AgentInfo, LimitHit } from "../../api/client";
import { agentDisplayName } from "../../lib/agentMention";
import { useT } from "../../i18n/react";
import { IconAlert } from "../icons";

type Props = {
  hit: LimitHit;
  hostAgentId: string;
  agents: AgentInfo[];
  focused?: boolean;
  busy?: string | null;
  onWait: () => void;
  onContinue: () => void;
  onSwitch: (agentId: string) => void;
  onDismiss: () => void;
};

function remainingSeconds(resetAt?: number): number | null {
  if (!resetAt || resetAt <= 0) return null;
  return Math.max(0, resetAt - Math.floor(Date.now() / 1000));
}

function formatRemain(secs: number): string {
  if (secs <= 0) return "0m";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export default function LimitCard({
  hit,
  hostAgentId,
  agents,
  focused,
  busy,
  onWait,
  onContinue,
  onSwitch,
  onDismiss,
}: Props) {
  const tr = useT();
  const [nowTick, setNowTick] = useState(0);
  const status = (hit.status || "open").toLowerCase();
  const terminal =
    status === "continued" || status === "switched" || status === "dismissed";
  const waiting = status === "waiting";

  useEffect(() => {
    if (terminal) return;
    const id = window.setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [terminal]);

  const remain = useMemo(() => remainingSeconds(hit.reset_at), [hit.reset_at, nowTick]);
  const agentLabel = agentDisplayName(hit.agent || hostAgentId);
  const fallbacks = agents.filter(
    (a) => a.available && a.id !== (hit.agent || hostAgentId),
  );

  const title = waiting
    ? tr("limit.waitingTitle", { agent: agentLabel })
    : tr("limit.title", { agent: agentLabel });

  const resetLabel =
    remain == null
      ? tr("limit.resetUnknown")
      : remain <= 0
        ? tr("limit.resetReady")
        : tr("limit.resetIn", { time: formatRemain(remain) });

  return (
    <div
      className={[
        "rounded-[12px] animate-slideIn overflow-hidden",
        focused
          ? "border-2 border-amber-400 shadow-[0_0_0_3px_rgba(251,191,36,.25)]"
          : "border border-[rgba(251,191,36,.55)] shadow-[0_8px_24px_rgba(251,191,36,.12)]",
        "bg-gradient-to-b from-[rgba(251,191,36,.12)] to-[rgba(251,191,36,.03)]",
      ].join(" ")}
      data-testid="limit-card"
    >
      <div className="px-3.5 py-3.5">
        <div className="flex items-center gap-2">
          <IconAlert size={15} className="text-amber-400 flex-none" />
          <span className="text-[12.5px] font-semibold text-amber-100">
            {title}
          </span>
          {hit.window ? (
            <span className="ml-auto rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-100">
              {hit.window}
            </span>
          ) : null}
        </div>

        <p className="mt-2 text-[13px] leading-relaxed text-kin-secondary">
          {hit.message || tr("limit.defaultMessage")}
        </p>
        <p className="mt-1 text-[12px] text-kin-muted">{resetLabel}</p>

        {terminal ? (
          <p className="mt-3 text-[12px] text-kin-muted">
            {status === "continued" && tr("limit.statusContinued")}
            {status === "switched" &&
              tr("limit.statusSwitched", {
                agent: agentDisplayName(hit.to_agent || ""),
              })}
            {status === "dismissed" && tr("limit.statusDismissed")}
          </p>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {waiting ? (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={onContinue}
                className="rounded-lg bg-amber-500/90 px-3 py-1.5 text-[12.5px] font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
              >
                {busy === "continue"
                  ? tr("limit.working")
                  : remain != null && remain <= 0
                    ? tr("limit.continueNow")
                    : tr("limit.continueEarly")}
              </button>
            ) : (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={onWait}
                className="rounded-lg bg-amber-500/90 px-3 py-1.5 text-[12.5px] font-medium text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
              >
                {busy === "wait" ? tr("limit.working") : tr("limit.wait")}
              </button>
            )}

            {!waiting && (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={onContinue}
                className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-[12.5px] text-amber-100 hover:bg-amber-500/20 disabled:opacity-50"
              >
                {busy === "continue" ? tr("limit.working") : tr("limit.continueNow")}
              </button>
            )}

            {fallbacks.slice(0, 3).map((a) => (
              <button
                key={a.id}
                type="button"
                disabled={Boolean(busy)}
                onClick={() => onSwitch(a.id)}
                className="rounded-lg border border-[var(--kin-hairline-strong)] bg-[var(--kin-panel)] px-3 py-1.5 text-[12.5px] text-kin-secondary hover:text-kin-primary disabled:opacity-50"
              >
                {busy === `switch:${a.id}`
                  ? tr("limit.working")
                  : tr("limit.switchTo", { agent: agentDisplayName(a.id) })}
              </button>
            ))}

            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={onDismiss}
              className="ml-auto rounded-lg px-2 py-1.5 text-[12px] text-kin-muted hover:text-kin-secondary disabled:opacity-50"
            >
              {busy === "dismiss" ? tr("limit.working") : tr("limit.dismiss")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
