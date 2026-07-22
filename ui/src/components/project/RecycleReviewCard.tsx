import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { ProjectRecycle, RecycleSuggestion } from "../../api/client";
import {
  acceptRecycleSuggestion,
  ApiError,
  ignoreRecycleSuggestion,
} from "../../api/client";
import { useT } from "../../i18n/react";

type Props = {
  recycle: ProjectRecycle;
  onChange: (next: ProjectRecycle) => void;
  onClose?: () => void;
  onConflict?: (info: {
    updated_at?: number;
    markdown?: string;
    error?: string;
  }) => void;
  className?: string;
};

function targetLabel(
  tr: (k: string, p?: Record<string, string | number>) => string,
  target: string,
): string {
  switch (target) {
    case "conclusions":
      return tr("task.recycleTargetConclusions");
    case "open_questions":
      return tr("task.recycleTargetOpenQuestions");
    case "next":
      return tr("task.recycleTargetNext");
    case "focus":
      return tr("task.recycleTargetFocus");
    default:
      return target;
  }
}

function statusLabel(
  tr: (k: string, p?: Record<string, string | number>) => string,
  status: string,
): string {
  switch (status) {
    case "accepted":
      return tr("task.recycleStatusAccepted");
    case "accepted_edited":
      return tr("task.recycleStatusAcceptedEdited");
    case "ignored":
      return tr("task.recycleStatusIgnored");
    default:
      return tr("task.recycleStatusPending");
  }
}

export default function RecycleReviewCard({
  recycle,
  onChange,
  onClose,
  onConflict,
  className = "",
}: Props) {
  const tr = useT();
  const [edits, setEdits] = useState<Record<number, string>>({});
  const [busyIdx, setBusyIdx] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [baseUpdatedAt, setBaseUpdatedAt] = useState(
    recycle.base_one_pager_updated_at,
  );

  const { focusItems, ordinaryItems } = useMemo(() => {
    const focusItems: { index: number; sug: RecycleSuggestion }[] = [];
    const ordinaryItems: { index: number; sug: RecycleSuggestion }[] = [];
    recycle.suggestions.forEach((sug, index) => {
      if (sug.target === "focus") focusItems.push({ index, sug });
      else ordinaryItems.push({ index, sug });
    });
    return { focusItems, ordinaryItems };
  }, [recycle.suggestions]);

  const pendingCount = recycle.suggestions.filter(
    (s) => !s.status || s.status === "pending",
  ).length;

  async function onAccept(index: number) {
    const sug = recycle.suggestions[index];
    if (!sug || sug.status !== "pending") return;
    setBusyIdx(index);
    setError(null);
    const finalText = (edits[index] ?? sug.text).trim() || sug.text;
    try {
      const res = await acceptRecycleSuggestion(recycle.id, index, {
        final_text: finalText,
        one_pager_updated_at: baseUpdatedAt,
      });
      if (res.updated_at) setBaseUpdatedAt(res.updated_at);
      onChange(res.recycle);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        const body = e.body as {
          updated_at?: number;
          markdown?: string;
          error?: string;
        } | undefined;
        onConflict?.(body || { error: e.message });
        setError(tr("task.recycleConflict"));
      } else {
        setError(e instanceof Error ? e.message : tr("task.recycleAcceptFailed"));
      }
    } finally {
      setBusyIdx(null);
    }
  }

  async function onIgnore(index: number) {
    const sug = recycle.suggestions[index];
    if (!sug || sug.status !== "pending") return;
    setBusyIdx(index);
    setError(null);
    try {
      const res = await ignoreRecycleSuggestion(recycle.id, index);
      onChange(res.recycle);
    } catch (e) {
      setError(e instanceof Error ? e.message : tr("task.recycleIgnoreFailed"));
    } finally {
      setBusyIdx(null);
    }
  }

  function renderItem(index: number, sug: RecycleSuggestion, focus: boolean) {
    const pending = !sug.status || sug.status === "pending";
    const text = edits[index] ?? sug.final_text ?? sug.text;
    return (
      <div
        key={index}
        className={[
          "rounded-xl border px-3 py-2.5",
          focus
            ? "border-kin-accent/40 bg-kin-accent/5"
            : "border-[var(--kin-hairline)] bg-[var(--kin-fill)]/40",
          !pending ? "opacity-70" : "",
        ].join(" ")}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-kin-muted">
            {targetLabel(tr, sug.target)}
            {focus ? ` · ${tr("task.recycleFocusBadge")}` : ""}
          </div>
          <div className="text-[11px] text-kin-muted">
            {statusLabel(tr, sug.status || "pending")}
          </div>
        </div>

        {pending ? (
          <textarea
            value={text}
            onChange={(e) =>
              setEdits((prev) => ({ ...prev, [index]: e.target.value }))
            }
            rows={focus ? 3 : 2}
            className="mt-2 w-full resize-y rounded-lg border border-[var(--kin-hairline)] bg-kin-panel px-2.5 py-1.5 text-[13px] text-kin-text outline-none focus:border-kin-accent/50"
          />
        ) : (
          <p className="mt-2 whitespace-pre-wrap text-[13px] text-kin-text">
            {sug.final_text || sug.text}
          </p>
        )}

        {sug.reason ? (
          <p className="mt-1.5 text-[11.5px] text-kin-secondary">{sug.reason}</p>
        ) : null}

        {sug.evidence && sug.evidence.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {sug.evidence.map((ev, i) => {
              if (ev.kind === "task" && ev.id) {
                return (
                  <Link
                    key={i}
                    to={`/tasks/${encodeURIComponent(ev.id)}`}
                    className="rounded-md border border-[var(--kin-hairline)] px-1.5 py-0.5 text-[11px] text-kin-secondary hover:text-kin-text"
                  >
                    {ev.label || tr("task.recycleEvidenceTask")}
                  </Link>
                );
              }
              if (ev.kind === "artifact" && ev.id) {
                return (
                  <Link
                    key={i}
                    to={`/artifacts/${encodeURIComponent(ev.id)}`}
                    className="rounded-md border border-[var(--kin-hairline)] px-1.5 py-0.5 text-[11px] text-kin-secondary hover:text-kin-text"
                  >
                    {ev.label || tr("task.recycleEvidenceArtifact")}
                  </Link>
                );
              }
              return (
                <span
                  key={i}
                  className="rounded-md border border-[var(--kin-hairline)] px-1.5 py-0.5 text-[11px] text-kin-muted"
                  title={ev.path || ""}
                >
                  {ev.path || ev.label || tr("task.recycleEvidenceFile")}
                </span>
              );
            })}
          </div>
        ) : null}

        {pending ? (
          <div className="mt-2.5 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busyIdx === index}
              onClick={() => void onAccept(index)}
              className="rounded-lg bg-kin-accent px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50"
            >
              {busyIdx === index
                ? tr("task.recycleWorking")
                : tr("task.recycleAccept")}
            </button>
            <button
              type="button"
              disabled={busyIdx === index}
              onClick={() => void onIgnore(index)}
              className="rounded-lg border border-[var(--kin-hairline)] px-2.5 py-1 text-[12px] text-kin-secondary hover:text-kin-text disabled:opacity-50"
            >
              {tr("task.recycleIgnore")}
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      className={[
        "rounded-2xl border border-kin-accent/30 bg-kin-panel shadow-sm",
        className,
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3 border-b border-[var(--kin-hairline)] px-4 py-3">
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-kin-text">
            {tr("task.recycleTitle")}
          </div>
          <p className="mt-0.5 text-[12.5px] text-kin-secondary">
            {recycle.summary || tr("task.recycleEmptySummary")}
          </p>
          <p className="mt-1 text-[11px] text-kin-muted">
            {pendingCount > 0
              ? tr("task.recyclePendingCount", { count: pendingCount })
              : tr("task.recycleAllHandled")}
          </p>
        </div>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            className="flex-none rounded-lg px-2 py-1 text-[12px] text-kin-muted hover:bg-[var(--kin-fill)] hover:text-kin-text"
          >
            {tr("common.close")}
          </button>
        ) : null}
      </div>

      <div className="space-y-2.5 px-4 py-3">
        {recycle.suggestions.length === 0 ? (
          <p className="text-[12.5px] text-kin-secondary">
            {tr("task.recycleNoSuggestions")}
          </p>
        ) : (
          <>
            {focusItems.map(({ index, sug }) => renderItem(index, sug, true))}
            {ordinaryItems.map(({ index, sug }) =>
              renderItem(index, sug, false),
            )}
          </>
        )}
        {error ? (
          <p className="text-[12px] text-red-500/90">{error}</p>
        ) : null}
      </div>
    </div>
  );
}
