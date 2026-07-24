import { useEffect, useMemo, useState } from "react";
import {
  type UserQuestion,
  parseUserQuestionPayload,
} from "../../api/client";
import { useT } from "../../i18n/react";
import { IconAlert } from "../icons";

type Props = {
  question: UserQuestion;
  focused?: boolean;
  busy?: boolean;
  onAnswer: (body: { selected: string[]; other_text: string }) => void;
};

export default function UserQuestionCard({
  question,
  focused,
  busy,
  onAnswer,
}: Props) {
  const tr = useT();
  const payload = useMemo(
    () => parseUserQuestionPayload(question.payload),
    [question.payload],
  );
  const multi = Boolean(payload.multi_select);
  const [selected, setSelected] = useState<string[]>([]);
  const [otherText, setOtherText] = useState("");

  function toggle(label: string) {
    setSelected((prev) => {
      if (multi) {
        return prev.includes(label)
          ? prev.filter((x) => x !== label)
          : [...prev, label];
      }
      return prev.includes(label) ? [] : [label];
    });
  }

  const canSubmit =
    !busy && (selected.length > 0 || otherText.trim().length > 0);

  function submit() {
    if (!canSubmit) return;
    onAnswer({ selected, other_text: otherText.trim() });
  }

  // Number keys 1–9 toggle options; Enter submits when the card is focused
  // and the event is not already handled by a form control.
  useEffect(() => {
    if (!focused || busy) return;
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) {
        // Still allow Enter-to-submit from the Other input.
        if (e.key === "Enter" && t.tagName === "INPUT") {
          e.preventDefault();
          submit();
        }
        return;
      }
      if (e.key >= "1" && e.key <= "9") {
        const idx = Number(e.key) - 1;
        const opt = payload.options[idx];
        if (opt) {
          e.preventDefault();
          toggle(opt.label);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- submit/toggle close over latest selected
  }, [focused, busy, payload.options, multi, selected, otherText]);

  return (
    <div
      className={[
        "rounded-[12px] animate-slideIn overflow-hidden",
        focused
          ? "border-2 border-indigo-400 shadow-[0_0_0_3px_rgba(99,102,241,.25)]"
          : "border border-[rgba(99,102,241,.55)] shadow-[0_8px_24px_rgba(99,102,241,.12)]",
        "bg-gradient-to-b from-[rgba(99,102,241,.12)] to-[rgba(99,102,241,.03)]",
      ].join(" ")}
      data-testid="user-question-card"
    >
      <div className="px-3.5 py-3.5">
        <div className="flex items-center gap-2">
          <IconAlert size={15} className="text-indigo-400 flex-none" />
          <span className="text-[12.5px] font-semibold text-indigo-200">
            {tr("question.cardTitle")}
          </span>
          {payload.header ? (
            <span className="ml-auto rounded-full border border-indigo-500/40 bg-indigo-500/10 px-2 py-0.5 text-[11px] text-indigo-200">
              {payload.header}
            </span>
          ) : null}
        </div>

        <p className="mt-2.5 text-[13.5px] leading-snug text-kin-primary">
          {payload.question || tr("question.fallback")}
        </p>

        <ul className="mt-3 space-y-1.5">
          {payload.options.map((opt, idx) => {
            const on = selected.includes(opt.label);
            return (
              <li key={`${opt.label}-${idx}`}>
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => toggle(opt.label)}
                  className={[
                    "w-full rounded-lg border px-3 py-2 text-left transition-colors",
                    on
                      ? "border-indigo-400 bg-indigo-500/20 text-indigo-50"
                      : "border-[var(--kin-hairline)] bg-black/20 text-kin-secondary hover:border-indigo-400/50 hover:text-kin-primary",
                    busy ? "opacity-60 cursor-not-allowed" : "",
                  ].join(" ")}
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded border border-indigo-400/40 text-[11px] text-indigo-200">
                      {idx + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium">
                        {opt.label}
                      </span>
                      {opt.description ? (
                        <span className="mt-0.5 block text-[11.5px] text-kin-muted">
                          {opt.description}
                        </span>
                      ) : null}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mt-3">
          <label className="block text-[11.5px] text-kin-muted mb-1">
            {tr("question.other")}
          </label>
          <input
            type="text"
            value={otherText}
            disabled={Boolean(busy)}
            onChange={(e) => setOtherText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={tr("question.otherPlaceholder")}
            className="w-full rounded-lg border border-[var(--kin-hairline)] bg-black/25 px-3 py-2 text-[13px] text-kin-primary placeholder:text-kin-muted focus:border-indigo-400 focus:outline-none"
          />
        </div>

        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className={[
              "rounded-lg px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors",
              canSubmit
                ? "bg-indigo-500 text-white hover:bg-indigo-400"
                : "bg-indigo-500/30 text-indigo-200/60 cursor-not-allowed",
            ].join(" ")}
          >
            {busy ? tr("question.submitting") : tr("question.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
