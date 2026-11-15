/* eslint-disable kin/no-raw-button -- markup moved unchanged from ProjectDetailPage; new controls should use a shared primitive. */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { OnePager } from "../../api/client";
import { onePagerFocus } from "../../lib/onePagerSummary";
import { SkeletonLine } from "../Skeleton";
import { useT } from "../../i18n/react";

/**
 * "One-line summary" on the project cover: the One-Pager's Current Focus,
 * editable in place (KIN-PROJECT-001 steps 2 and 5).
 *
 * The edit state is local to this section; the page keeps the network save and
 * the leave guard. A save is posted against the version the editor opened, not
 * whatever a reconnect has since read, and a 409 keeps the editor open with the
 * other device's line — the conflict is a state of this block, not the page.
 */
type Props = {
  titleId: string;
  loaded: boolean;
  loading: boolean;
  loadError: string | null;
  /** The line the section displays when it is not being edited. */
  summaryText: string;
  saving: boolean;
  saved: boolean;
  conflict: OnePager | null;
  offline: boolean;
  onRetry: () => void;
  /** The edited body, saved against the version the editor opened. */
  onSave: (body: string) => void;
  /** The version the editor opens; later reads must not replace it. */
  onBeginEdit: () => void;
  /** Overwrite the other device's document with this body. */
  onKeepMine: (body: string) => void;
  onTakeTheirs: () => void;
  /** Cancel or dismiss the conflict without saving. */
  onDismissConflict: () => void;
  onEditingChange: (editing: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
};

export default function ProjectOnePager({
  titleId,
  loaded,
  loading,
  loadError,
  summaryText,
  saving,
  saved,
  conflict,
  offline,
  onRetry,
  onSave,
  onBeginEdit,
  onKeepMine,
  onTakeTheirs,
  onDismissConflict,
  onEditingChange,
  onDirtyChange,
}: Props) {
  const tr = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(summaryText);
  const summaryFieldRef = useRef<HTMLTextAreaElement | null>(null);
  const editButtonRef = useRef<HTMLButtonElement | null>(null);

  const dirty = editing && draft.trim() !== summaryText.trim();

  useEffect(() => {
    onEditingChange(editing);
  }, [editing, onEditingChange]);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  // A reconnect may bring a newer line; it must not replace one being typed.
  useEffect(() => {
    if (!editing) setDraft(summaryText);
  }, [editing, summaryText]);

  // A successful save closes the editor once the page has accepted it.
  useEffect(() => {
    if (saved && editing) setEditing(false);
  }, [saved, editing]);

  useEffect(() => {
    if (!editing) return;
    const field = summaryFieldRef.current;
    if (!field) return;
    field.focus();
    const end = field.value.length;
    try {
      field.setSelectionRange(end, end);
    } catch {
      // Some browsers refuse selection on a hidden field; focus is enough.
    }
  }, [editing]);

  const focusEditButton = () => {
    const focus = () => editButtonRef.current?.focus();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(focus);
    else focus();
  };

  const beginEdit = () => {
    setDraft(summaryText);
    onBeginEdit();
    setEditing(true);
  };

  const cancelEdit = () => {
    setDraft(summaryText);
    setEditing(false);
    onDismissConflict();
    focusEditButton();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (!saving && !offline) onSave(draft);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancelEdit();
    }
  };

  const takeTheirs = () => {
    onTakeTheirs();
    setEditing(false);
    focusEditButton();
  };

  return (
    <section aria-labelledby={titleId} className="rounded-xl bg-kin-panel p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2
          id={titleId}
          className="text-body font-medium uppercase tracking-label text-kin-secondary"
        >
          {tr("projects.summaryTitle")}
        </h2>
        {!editing && loaded && (
          <button
            ref={editButtonRef}
            type="button"
            disabled={offline}
            className="rounded-lg border border-kin-hairline px-3 py-1.5 text-strong text-kin-text hover:bg-[var(--kin-fill-strong)] disabled:opacity-50"
            onClick={beginEdit}
          >
            {tr("projects.summaryEdit")}
          </button>
        )}
      </div>

      {loadError && (
        <div
          role="alert"
          className="mb-3 rounded-lg border border-kin-red/30 bg-kin-red/10 px-3 py-2 text-body text-kin-red-ink"
        >
          <p>{loadError}</p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 min-h-11 rounded-lg border border-kin-red/40 px-3 text-strong text-kin-red-ink"
          >
            {tr("common.retry")}
          </button>
        </div>
      )}

      {!loaded ? (
        loading ? (
          <div className="space-y-3 py-2">
            <SkeletonLine />
            <SkeletonLine />
          </div>
        ) : null
      ) : editing ? (
        <>
          <textarea
            ref={summaryFieldRef}
            aria-label={tr("projects.summaryTitle")}
            className="min-h-16 w-full resize-y rounded-lg border border-kin-hairline bg-transparent p-3 text-strong leading-prose text-kin-text outline-none focus:border-kin-blue/40"
            value={draft}
            maxLength={300}
            placeholder={tr("projects.summaryPlaceholder")}
            disabled={offline || saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {offline ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="text-caption text-kin-muted">{tr("projects.summaryOffline")}</p>
              <button
                type="button"
                className="min-h-11 rounded-lg px-3 text-strong text-kin-secondary"
                onClick={cancelEdit}
              >
                {tr("common.cancel")}
              </button>
            </div>
          ) : conflict ? (
            <div
              role="alert"
              className="mt-3 rounded-lg border border-kin-red/30 bg-kin-red/10 px-3 py-2 text-body text-kin-red-ink"
            >
              <p className="font-medium">{tr("projects.conflictTitle")}</p>
              <p className="mt-1 whitespace-pre-wrap text-strong">
                {conflict.one_pager_summary?.focus ||
                  onePagerFocus(conflict.markdown) ||
                  tr("projects.summaryEmpty")}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={saving}
                  className="min-h-11 rounded-lg bg-kin-blue px-3 text-strong font-medium text-kin-on-brand disabled:opacity-50"
                  onClick={() => onKeepMine(draft)}
                >
                  {tr("projects.conflictKeepMine")}
                </button>
                <button
                  type="button"
                  className="min-h-11 rounded-lg border border-kin-hairline px-3 text-strong text-kin-text"
                  onClick={takeTheirs}
                >
                  {tr("projects.conflictTakeTheirs")}
                </button>
                <button
                  type="button"
                  className="min-h-11 rounded-lg px-3 text-strong text-kin-secondary"
                  // Dismissing keeps the old base on purpose: the next save
                  // meets the same 409 instead of silently overwriting the
                  // version this editor has not read.
                  onClick={onDismissConflict}
                >
                  {tr("projects.conflictDismiss")}
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={saving}
                className="min-h-11 rounded-lg bg-kin-blue px-3 text-strong font-medium text-kin-on-brand disabled:opacity-50"
                onClick={() => onSave(draft)}
              >
                {saving ? tr("projects.summarySaving") : tr("common.save")}
              </button>
              <button
                type="button"
                className="min-h-11 rounded-lg px-3 text-strong text-kin-secondary"
                onClick={cancelEdit}
              >
                {tr("common.cancel")}
              </button>
            </div>
          )}
        </>
      ) : (
        <p
          className={[
            "text-strong leading-prose",
            summaryText ? "text-kin-text" : "text-kin-secondary",
          ].join(" ")}
        >
          {summaryText || tr("projects.summaryEmpty")}
        </p>
      )}
      {!editing && loaded && saved && (
        <p role="status" className="mt-2 text-caption text-kin-muted">
          {tr("projects.summarySaved")}
        </p>
      )}
    </section>
  );
}
