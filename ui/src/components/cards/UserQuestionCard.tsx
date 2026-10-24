import { useEffect, useMemo, useState } from "react";
import { type UserQuestion, parseUserQuestionPayload } from "../../api/client";
import { useT } from "../../i18n/react";
import { IconAlert } from "../icons";

type Props = {
  question: UserQuestion;
  focused?: boolean;
  busy?: boolean;
  onAnswer: (body: { selected: string[]; other_text: string }) => void;
};

export default function UserQuestionCard({ question, focused, busy, onAnswer }: Props) {
  const tr = useT();
  const payload = useMemo(() => parseUserQuestionPayload(question.payload), [question.payload]);
  const multi = Boolean(payload.multi_select);
  const [selected, setSelected] = useState<string[]>([]);
  const [otherText, setOtherText] = useState("");

  function toggle(label: string) {
    setSelected((prev) => {
      if (multi) {
        return prev.includes(label) ? prev.filter((x) => x !== label) : [...prev, label];
      }
      return prev.includes(label) ? [] : [label];
    });
  }

  const canSubmit = !busy && (selected.length > 0 || otherText.trim().length > 0);

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
        "rounded-xl animate-slideIn overflow-hidden",
        // Armed (the number keys are wired to this card) reads as the same
        // solid edge its siblings `LimitCard` and `ApprovalCard` use — a 40%
        // border here was *fainter* than the 55% on an unarmed card.
        focused
          ? "border-2 border-kin-orange ring ring-kin-orange/25"
          : "border border-kin-orange/55 shadow-e2",
        "bg-gradient-to-b from-kin-orange/10 to-kin-orange/5",
      ].join(" ")}
      data-testid="user-question-card"
    >
      <div className="px-3.5 py-3.5">
        <div className="flex items-center gap-2">
          <IconAlert size={15} className="text-kin-orange-ink flex-none" />
          <span className="text-body font-semibold text-kin-orange-ink">
            {tr("question.cardTitle")}
          </span>
          {payload.header ? (
            <span className="ml-auto rounded-full border border-kin-orange/40 bg-kin-orange/10 px-2 py-0.5 text-caption text-kin-orange-ink">
              {payload.header}
            </span>
          ) : null}
        </div>

        <p className="mt-2.5 text-strong leading-ui text-kin-orange-ink">
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
                      ? "border-kin-orange bg-kin-orange/15 text-kin-orange-ink"
                      : "border-[var(--kin-hairline)] bg-kin-fill text-kin-secondary hover:border-kin-orange/50 hover:text-kin-orange-ink",
                    busy ? "opacity-60 cursor-not-allowed" : "",
                  ].join(" ")}
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded border border-kin-orange/40 text-caption text-kin-orange-ink">
                      {idx + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-strong font-medium">{opt.label}</span>
                      {opt.description ? (
                        <span className="mt-0.5 block text-caption text-kin-muted">
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
          <label className="block text-caption text-kin-muted mb-1">{tr("question.other")}</label>
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
            // The typed answer is the user's own words, not the card's status
            // message — orange ink is for what the card is *saying*.
            className="w-full rounded-lg border border-[var(--kin-hairline)] bg-kin-fill px-3 py-2 text-strong text-kin-text placeholder:text-kin-muted focus:border-kin-orange/50 focus:outline-none focus:ring-1 focus:ring-kin-focus-ring"
          />
        </div>

        <div className="mt-3 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className={[
              "rounded-lg px-3.5 py-1.5 text-body font-semibold transition-colors",
              canSubmit
                ? "bg-kin-orange text-kin-on-status hover:brightness-110"
                : "bg-kin-orange/15 text-kin-orange-ink/60 cursor-not-allowed",
            ].join(" ")}
          >
            {busy ? tr("question.submitting") : tr("question.submit")}
          </button>
        </div>
      </div>
    </div>
  );
}
