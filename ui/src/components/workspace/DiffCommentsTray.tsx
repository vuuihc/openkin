import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useT } from "../../i18n/react";
import Button from "../ui/Button";
import type { CommentAnchorState, DiffComment } from "./diffCommentAnchor";

export type DiffCommentsTrayProps = {
  /** The conversation's saved comments, oldest first. */
  comments: DiffComment[];
  /**
   * KIN-RESULT-003 part 2: where each comment points in the diff open now.
   * An absent id renders as saved (live/unknown) — never implied stale.
   */
  anchors?: Record<string, CommentAnchorState>;
  /** Reveal and highlight the line a row points at. */
  onJump: (comment: DiffComment) => void;
  /** Remove one comment immediately — deletion is local and final. */
  onDelete: (id: string) => void;
  /** Send the whole tray as one ordinary follow-up. Rejects on failure. */
  onSend: () => Promise<void>;
  /** Esc: close the tray and hand focus back to the diff. */
  onClose: () => void;
  returnFocus?: () => void;
};

/**
 * KIN-RESULT-003 — the tray of comments for one conversation.
 *
 * It renders only when there is something to show: an empty tray is not a
 * panel, it is a promise of a feature nobody used. The send action is a single
 * ordinary follow-up message — the page owns that call, so this component can
 * be tested without a composer, and a failed send leaves every comment where
 * it was.
 */
export default function DiffCommentsTray({
  comments,
  anchors,
  onJump,
  onDelete,
  onSend,
  onClose,
  returnFocus,
}: DiffCommentsTrayProps) {
  const tr = useT();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);
  const rowsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const pendingFocus = useRef<number | null>(null);

  // Focus the row that took the deleted one's place — the next one, or the
  // last one when the tail was removed. Losing focus to `<body>` after a
  // delete is how a keyboard user falls out of the tray.
  useEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    rowsRef.current[Math.min(index, comments.length - 1)]?.focus();
  }, [comments]);

  const send = async () => {
    if (sending) return;
    setSending(true);
    setFailed(false);
    try {
      await onSend();
      setSent(true);
    } catch {
      // The comments stay exactly where they were. There is no composer here
      // to restore, so this surface says what happened and the button is the
      // retry.
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  if (comments.length === 0) {
    return sent ? (
      <p className="px-3 py-2 text-caption text-kin-green-ink">{tr("workspace.comments.sent")}</p>
    ) : null;
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      returnFocus?.();
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const stops = rowsRef.current.filter((row): row is HTMLButtonElement => Boolean(row));
    const index = stops.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    event.preventDefault();
    stops[index + (event.key === "ArrowDown" ? 1 : -1)]?.focus();
  };

  return (
    <section
      aria-label={tr("workspace.comments.trayTitle")}
      // `flex-none`: the diff above it gives up the height. A shrinkable tray
      // lost the argument with the editor and its first row was clipped at the
      // bottom of the pane instead of being scrolled to.
      className="flex-none flex flex-col border-t border-[var(--kin-hairline)] bg-[var(--kin-bg)]"
      onKeyDown={handleKeyDown}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-caption font-semibold text-kin-secondary">
          {tr("workspace.comments.showTray", { count: comments.length })}
        </span>
        <Button
          className="ml-auto text-caption md:min-h-0 md:py-1 md:px-2"
          disabled={sending}
          isLoading={sending}
          onClick={() => void send()}
        >
          {sending
            ? tr("workspace.comments.sending")
            : tr("workspace.comments.send", { count: comments.length })}
        </Button>
      </div>
      {failed && (
        <p className="px-3 pb-1 text-caption text-kin-red-ink">
          {tr("workspace.comments.sendFailed")}
        </p>
      )}
      <ul className="max-h-64 overflow-y-auto kin-scroll">
        {comments.map((comment, index) => {
          const anchor = anchors?.[comment.id];
          // No anchor state is "as saved", never "stale": the tray only says
          // the line has changed when the fresh diff said so.
          const line = anchor?.line ?? comment.line;
          const stale = anchor?.stale === true;
          return (
            <li
              key={comment.id}
              className="flex items-start gap-1 border-t border-[var(--kin-hairline)] px-1"
            >
              <Button
                ref={(element) => {
                  rowsRef.current[index] = element;
                }}
                variant="quiet"
                aria-label={
                  stale
                    ? tr("workspace.comments.staleRow", { path: comment.path, line })
                    : tr("workspace.comments.jumpToRow", { path: comment.path, line })
                }
                className="flex-1 min-w-0 min-h-11 sm:min-h-0 h-auto! flex-col items-start justify-start gap-0.5 px-2 py-2 text-left"
                onClick={() => onJump(comment)}
              >
                {/* Astryx wraps `children` in its own row-direction label span,
                    so the stack has to be one child of our own. */}
                <span className="flex w-full min-w-0 flex-col items-start gap-0.5">
                  <span className="font-mono text-caption text-kin-secondary">
                    {comment.path}:{line}
                  </span>
                  <span className="w-full truncate font-mono text-micro text-kin-muted">
                    {comment.quote}
                  </span>
                  {stale && (
                    // The failure state is text, not colour alone: the row also
                    // keeps the hunk header it was written in, so a person can
                    // still find the place the agent changed.
                    <span className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="rounded bg-[var(--kin-fill-strong)] px-1.5 py-0.5 text-micro font-semibold text-kin-secondary">
                        {tr("workspace.comments.stale")}
                      </span>
                      <span className="truncate font-mono text-micro text-kin-muted">
                        {comment.hunkHeader}
                      </span>
                    </span>
                  )}
                  <span className="w-full text-body text-kin-text whitespace-pre-wrap break-words">
                    {comment.text}
                  </span>
                </span>
              </Button>
              <Button
                variant="quiet-danger"
                aria-label={tr("workspace.comments.deleteRow", {
                  path: comment.path,
                  line,
                })}
                className="flex-none min-h-11 sm:min-h-0 px-2 py-1 text-caption"
                onClick={() => {
                  pendingFocus.current = index;
                  onDelete(comment.id);
                }}
              >
                {tr("workspace.comments.delete")}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
