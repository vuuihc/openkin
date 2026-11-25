import { useEffect, useMemo, useState } from "react";
import { type UserQuestion, parseUserQuestionPayload } from "../../api/client";
import { useT } from "../../i18n/react";
import { IconAlert } from "../icons";
import Button from "../ui/Button";

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
        // A form control owns its own keys. The Other input's `onKeyDown`
        // already submits on Enter; answering here as well would send the same
        // answer twice whenever this card is the focused one.
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
        // Enter belongs to whatever control the person is standing on. A button
        // or a link activates on Enter, and this listener is on `window`, so
        // `preventDefault` here would cancel that activation and answer the
        // question instead. Reachable because a notification arms this card
        // through `?focus=…`, and the conversation around it is full of
        // buttons.
        const ownsEnter =
          t instanceof Element && t.closest("button, a[href], select, [role='button']") !== null;
        if (ownsEnter) return;
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
        // Focused means "this is the one your notification named" — the same
        // claim `ApprovalCard` draws, so it is drawn the same way: the app's
        // blue, a 2px edge and a badge. An edge in the card's own orange was
        // tried and is the wrong signal: a card nobody named already has an
        // orange border, and thickening it leaves the eye comparing widths.
        focused
          ? "border-2 border-kin-blue ring ring-kin-blue/20"
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
          {focused && (
            <span className="text-micro font-semibold uppercase tracking-label text-kin-blue-ink bg-kin-blue/15 rounded px-1.5 py-0.5">
              {tr("needsYou.focused")}
            </span>
          )}
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
                <Button
                  variant="secondary"
                  disabled={Boolean(busy)}
                  // The tile holds a number, a label and a description; the
                  // option's own label is the name a reader should hear, and
                  // the description stays reachable as its description.
                  aria-label={opt.label}
                  aria-describedby={
                    opt.description ? `${question.id}-option-${idx}-description` : undefined
                  }
                  aria-pressed={on}
                  onClick={() => toggle(opt.label)}
                  className={[
                    // The tile keeps its own edge, fill and left alignment;
                    // `secondary` supplies only the bordered peer's layer.
                    "w-full justify-start px-3 py-2 text-left text-body font-normal",
                    on
                      ? "border-kin-orange bg-kin-orange/15 text-kin-orange-ink"
                      : "border-[var(--kin-hairline)] bg-kin-fill text-kin-secondary hover:border-kin-orange/50 hover:text-kin-orange-ink",
                  ].join(" ")}
                >
                  <div className="flex w-full items-start gap-2">
                    <span className="mt-0.5 inline-flex h-5 w-5 flex-none items-center justify-center rounded border border-kin-orange/40 text-caption text-kin-orange-ink">
                      {idx + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-strong font-medium">{opt.label}</span>
                      {opt.description ? (
                        <span
                          id={`${question.id}-option-${idx}-description`}
                          className="mt-0.5 block text-caption text-kin-muted"
                        >
                          {opt.description}
                        </span>
                      ) : null}
                    </span>
                  </div>
                </Button>
              </li>
            );
          })}
        </ul>

        {/* The free-text row is a control a floating surface must not cover:
            `FloatingApproval` measures every `[data-kin-hit-row]` box before
            it draws the decision card, and on a 390-wide phone the strip sat
            on this field and took the tap. The marker is on the row — the
            label and the input together — because a tap anywhere in it is the
            same intent, not only on the input's own 44px. The `phone` value
            scopes the yield to the band the defect was filed in: from 768 up
            the conversation is a column beside the list, the field measured
            self-hit, and the card keeps its present shape. */}
        <div className="mt-3" data-kin-hit-row="phone">
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
          {/* The card's one filled action. `approve` is the console's orange
              filled weight; while it has nothing to send it keeps the old 15%
              tint rather than a dimmed solid fill (TASTE 6). */}
          <Button
            variant="approve"
            disabled={!canSubmit}
            onClick={submit}
            className="px-3.5 py-1.5 text-body disabled:bg-kin-orange/15 disabled:text-kin-orange-ink/60"
          >
            {busy ? tr("question.submitting") : tr("question.submit")}
          </Button>
        </div>
      </div>
    </div>
  );
}
