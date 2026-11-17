import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useT } from "../../i18n/react";
import Button from "../ui/Button";
import TextArea from "../ui/TextArea";
import type { CommentAnchorState, DiffComment } from "./diffCommentAnchor";

export type DiffCommentsTrayProps = {
  /** The conversation's saved comments, oldest first. */
  comments: DiffComment[];
  /**
   * KIN-RESULT-003 part 2: where each comment points in the diff open now.
   * An absent id renders as saved (live/unknown) — never implied stale.
   */
  anchors?: Record<string, CommentAnchorState>;
  /**
   * The most recent delete, still undoable: the comment and the position it
   * held. The page owns this slot so the undo outlives the last row.
   */
  undo?: { comment: DiffComment; index: number } | null;
  /** Reveal and highlight the line a row points at. */
  onJump: (comment: DiffComment) => void;
  /** Remove one comment immediately — the page keeps it as an undo slot. */
  onDelete: (id: string) => void;
  /** Put an undone comment back at the position it held. */
  onRestore: (comment: DiffComment, index: number) => void;
  /** Save a row's new words; the anchor (path, hunk, quote, line) stays. */
  onEdit: (id: string, text: string) => void;
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
 * panel, it is a promise of a feature nobody used. The one exception is a
 * delete's undo, which stays as a single line after the last row is gone —
 * the same way the send confirmation does. The send action is a single
 * ordinary follow-up message — the page owns that call, so this component can
 * be tested without a composer, and a failed send leaves every comment where
 * it was.
 */
export default function DiffCommentsTray({
  comments,
  anchors,
  undo,
  onJump,
  onDelete,
  onRestore,
  onEdit,
  onSend,
  onClose,
  returnFocus,
}: DiffCommentsTrayProps) {
  const tr = useT();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [editEmpty, setEditEmpty] = useState(false);
  const rowsRef = useRef<Array<HTMLButtonElement | null>>([]);
  const pendingFocus = useRef<number | null>(null);
  const editFieldRef = useRef<HTMLTextAreaElement | null>(null);
  // Where focus goes once the editor closes — the row it belonged to.
  const focusRowAfterEdit = useRef<number | null>(null);
  // The delete that emptied the tray hands focus back to the diff, once.
  const focusDiffAfterEmpty = useRef(false);

  // Focus the row that took the deleted one's place — the next one, or the
  // last one when the tail was removed. Losing focus to `<body>` after a
  // delete is how a keyboard user falls out of the tray.
  useEffect(() => {
    const index = pendingFocus.current;
    if (index === null) return;
    pendingFocus.current = null;
    rowsRef.current[Math.min(index, comments.length - 1)]?.focus();
  }, [comments]);

  // Deleting the last row must not strand focus on a button that no longer
  // exists: it goes back to the diff, next to the line review continues on.
  useEffect(() => {
    if (comments.length > 0 || !focusDiffAfterEmpty.current) return;
    focusDiffAfterEmpty.current = false;
    returnFocus?.();
  }, [comments, returnFocus]);

  // Opening the editor starts a keyboard flow: the field takes focus.
  useEffect(() => {
    if (editingId === null) return;
    editFieldRef.current?.focus();
  }, [editingId]);

  // Closing the editor puts focus back on the row it belonged to, not on
  // `<body>`; both save and Esc come through here.
  useEffect(() => {
    if (editingId !== null) return;
    const index = focusRowAfterEdit.current;
    if (index === null) return;
    focusRowAfterEdit.current = null;
    rowsRef.current[index]?.focus();
  }, [editingId]);

  const send = async () => {
    if (sending) return;
    setSending(true);
    setFailed(false);
    try {
      await onSend();
      setSent(true);
      // §4 键盘: ⌘Enter sends and the keyboard lands back in the diff. The
      // same is true of the button, which also unmounts the tray.
      returnFocus?.();
    } catch {
      // The comments stay exactly where they were. There is no composer here
      // to restore, so this surface says what happened and the button is the
      // retry — and focus stays in the tray, not out in the diff.
      setFailed(true);
    } finally {
      setSending(false);
    }
  };

  const startEdit = (comment: DiffComment) => {
    setEditingId(comment.id);
    setEditDraft(comment.text);
    setEditEmpty(false);
  };

  const closeEditor = () => {
    const index = comments.findIndex((comment) => comment.id === editingId);
    focusRowAfterEdit.current = index === -1 ? null : index;
    setEditingId(null);
    setEditDraft("");
    setEditEmpty(false);
  };

  const saveEdit = () => {
    if (editingId === null) return;
    const text = editDraft.trim();
    if (!text) {
      // An edit may not empty a comment; the tray says so and keeps the box.
      setEditEmpty(true);
      return;
    }
    onEdit(editingId, text);
    closeEditor();
  };

  const undoDelete = () => {
    if (!undo) return;
    // The restored row is the one that should hold focus, at its old place.
    pendingFocus.current = undo.index;
    onRestore(undo.comment, undo.index);
  };

  // The one-line undo, shared by the full tray and the empty-tray state.
  const undoLine = undo ? (
    <div className="flex items-center gap-1.5 px-3 py-2 text-caption text-kin-secondary">
      <span>{tr("workspace.comments.deleted")}</span>
      <span aria-hidden="true">·</span>
      <Button
        variant="quiet"
        className="min-h-11 sm:min-h-0 px-2 py-1 text-caption"
        onClick={undoDelete}
      >
        {tr("workspace.comments.undo")}
      </Button>
    </div>
  ) : null;

  if (comments.length === 0) {
    // A delete's undo outlives the last row: the tray itself is not a panel
    // anymore, just the same one-line acknowledgement a send gets.
    if (undoLine) return undoLine;
    return sent ? (
      <p className="px-3 py-2 text-caption text-kin-green-ink">{tr("workspace.comments.sent")}</p>
    ) : null;
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    // While a row is being edited its own keys win: ⌘Enter saves and Esc
    // cancels there, and neither may reach the tray's send or close — that
    // would throw away the draft and send the old words.
    if (editingId !== null) return;
    // §4 键盘: the whole tray goes back to the conversation in one keystroke.
    // Ctrl is the same gesture on a keyboard without ⌘.
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      void send();
      return;
    }
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
      {undoLine}
      <ul className="max-h-64 overflow-y-auto kin-scroll">
        {comments.map((comment, index) => {
          const anchor = anchors?.[comment.id];
          // No anchor state is "as saved", never "stale": the tray only says
          // the line has changed when the fresh diff said so.
          const line = anchor?.line ?? comment.line;
          const stale = anchor?.stale === true;
          const editing = editingId === comment.id;
          return (
            <li
              key={comment.id}
              className="flex items-start gap-1 border-t border-[var(--kin-hairline)] px-1"
            >
              {editing ? (
                // Edit is words-only, in place: the row keeps its anchor
                // (path, hunk header, quote, line) and its id throughout.
                <div
                  className="flex-1 min-w-0 flex flex-col gap-1.5 px-2 py-2"
                  onKeyDown={(event) => {
                    // The whole editor — field and actions — owns Esc and
                    // ⌘Enter. Scoping this to the textarea alone let the same
                    // keys on Save/Cancel reach the tray and send the set.
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      closeEditor();
                      return;
                    }
                    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault();
                      event.stopPropagation();
                      saveEdit();
                    }
                  }}
                >
                  <span className="font-mono text-caption text-kin-secondary">
                    {comment.path}:{line}
                  </span>
                  <TextArea
                    ref={editFieldRef}
                    label={tr("workspace.comments.fieldLabel")}
                    isLabelHidden
                    rows={2}
                    value={editDraft}
                    status={
                      editEmpty
                        ? { type: "error", message: tr("workspace.comments.empty") }
                        : undefined
                    }
                    onChange={(event) => {
                      setEditDraft(event.target.value);
                      if (editEmpty && event.target.value.trim()) setEditEmpty(false);
                    }}
                  />
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="secondary"
                      className="min-h-11 sm:min-h-0 px-2 py-1 text-caption"
                      onClick={closeEditor}
                    >
                      {tr("workspace.comments.cancel")}
                    </Button>
                    <Button
                      className="min-h-11 sm:min-h-0 px-2 py-1 text-caption"
                      onClick={saveEdit}
                    >
                      {tr("workspace.comments.save")}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
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
                    variant="quiet"
                    aria-label={tr("workspace.comments.editRow", {
                      path: comment.path,
                      line,
                    })}
                    className="flex-none min-h-11 sm:min-h-0 px-2 py-1 text-caption"
                    onClick={() => startEdit(comment)}
                  >
                    {tr("workspace.comments.edit")}
                  </Button>
                  <Button
                    variant="quiet-danger"
                    aria-label={tr("workspace.comments.deleteRow", {
                      path: comment.path,
                      line,
                    })}
                    className="flex-none min-h-11 sm:min-h-0 px-2 py-1 text-caption"
                    onClick={() => {
                      if (comments.length === 1) {
                        focusDiffAfterEmpty.current = true;
                      } else {
                        pendingFocus.current = index;
                      }
                      onDelete(comment.id);
                    }}
                  >
                    {tr("workspace.comments.delete")}
                  </Button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
