import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n/react";
import Button from "../ui/Button";
import TextArea from "../ui/TextArea";
import type { DiffAnchor } from "./diffCommentAnchor";

export type DiffCommentGutterProps = {
  /** The line being commented: file, hunk header, quote, line number. */
  anchor: DiffAnchor;
  /** The parent's retained draft for this line, restored on reopen. */
  initialDraft?: string;
  /** Save trimmed text; the parent puts it in the tray. */
  onSave: (text: string) => void;
  /** Cancel, reporting what was typed so the parent can keep it as a draft. */
  onCancel: (draft: string) => void;
  /** Where focus goes after the box closes — the diff line it came from. */
  returnFocus?: () => void;
};

/**
 * KIN-RESULT-003 — the comment box docked under the diff.
 *
 * Deliberately not an inline Monaco widget: the same box is the phone's
 * full-width sheet and the Mac dock, so it renders as ordinary React next to
 * the editor. It names its anchor (path, hunk header, quoted line) so the
 * person never has to remember which line they are talking about, and it keeps
 * the draft on Esc instead of eating it.
 */
export default function DiffCommentGutter({
  anchor,
  initialDraft = "",
  onSave,
  onCancel,
  returnFocus,
}: DiffCommentGutterProps) {
  const tr = useT();
  const [draft, setDraft] = useState(initialDraft);
  const [empty, setEmpty] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);

  // Opening the box is the start of the keyboard flow: the field takes focus.
  useEffect(() => {
    fieldRef.current?.focus();
  }, [anchor.path, anchor.line]);

  // A different line is a different comment; the parent's draft for it wins.
  useEffect(() => {
    setDraft(initialDraft);
    setEmpty(false);
  }, [anchor.path, anchor.line, initialDraft]);

  const submit = () => {
    const text = draft.trim();
    if (!text) {
      setEmpty(true);
      return;
    }
    setEmpty(false);
    onSave(text);
    returnFocus?.();
  };

  const cancel = () => {
    onCancel(draft);
    returnFocus?.();
  };

  return (
    <section
      aria-label={tr("workspace.comments.boxTitle", { path: anchor.path, line: anchor.line })}
      className="flex flex-col gap-2 border-b border-[var(--kin-hairline)] bg-[var(--kin-fill)] px-3 py-2"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="font-mono text-caption text-kin-secondary">
          {anchor.path}:{anchor.line}
        </span>
        <code className="font-mono text-micro text-kin-muted">{anchor.hunkHeader}</code>
      </div>
      <blockquote className="border-l-2 border-[var(--kin-hairline)] pl-2 font-mono text-caption text-kin-muted whitespace-pre-wrap break-all">
        {anchor.quote}
      </blockquote>
      <TextArea
        ref={fieldRef}
        label={tr("workspace.comments.fieldLabel")}
        isLabelHidden
        rows={3}
        value={draft}
        placeholder={tr("workspace.comments.placeholder")}
        status={empty ? { type: "error", message: tr("workspace.comments.empty") } : undefined}
        onChange={(event) => {
          setDraft(event.target.value);
          if (empty && event.target.value.trim()) setEmpty(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancel();
            return;
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex items-center justify-end gap-2">
        <Button variant="secondary" onClick={cancel}>
          {tr("workspace.comments.cancel")}
        </Button>
        <Button onClick={submit}>{tr("workspace.comments.save")}</Button>
      </div>
    </section>
  );
}
