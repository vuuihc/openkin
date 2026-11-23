import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ApiError, getOnePager, putOnePager, type OnePager } from "../../api/client";
import { onePagerFocus, setOnePagerFocus } from "../../lib/onePagerSummary";
import { useCoarsePointer } from "../../hooks/useMediaQuery";
import { useT } from "../../i18n/react";
import Sheet from "../mobile/Sheet";
import { SkeletonLine } from "../Skeleton";
import Button from "../ui/Button";
import Dialog from "../ui/Dialog";
import InlineAlert from "../ui/InlineAlert";
import TextArea from "../ui/TextArea";

/**
 * The project's one-line summary, edited from the project row.
 *
 * This is the cover's `ProjectOnePager` editor without the page: the same
 * focus line, the same 409 contract, and the same copy. The row is where a
 * person already chooses a project, so the editor opens over the list — a
 * bottom sheet on a coarse pointer (an 820 tablet included), a dialog on a
 * Mac — and never navigates to `/projects/:id`.
 *
 * Only the Current Focus section is written. A save posts
 * `setOnePagerFocus(base, draft)` against the version the editor opened, so a
 * 409 is a state of this editor: their line is shown, "keep mine" composes on
 * their document, and dismissing keeps the old base so the next save meets the
 * same conflict instead of silently overwriting a version nobody read.
 *
 * The read is generation-guarded: the editor is mounted by the list for its
 * whole life, so a late answer for a closed sheet or a different project is
 * dropped rather than painted.
 */
type Base = { markdown: string; updatedAt: number };

export default function ProjectSummaryEditor({
  open,
  projectId,
  offline,
  onClose,
}: {
  open: boolean;
  projectId: string | null;
  offline: boolean;
  onClose: () => void;
}) {
  const tr = useT();
  const coarse = useCoarsePointer();
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [base, setBase] = useState<Base>({ markdown: "", updatedAt: 0 });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<OnePager | null>(null);
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  // One generation per open / project. A re-open bumps it, and an answer from
  // the previous generation cannot paint over the newer state.
  const generation = useRef(0);

  const load = useCallback((id: string) => {
    const current = (generation.current += 1);
    setLoading(true);
    setLoaded(false);
    setLoadFailed(false);
    setConflict(null);
    setSaveError(null);
    getOnePager(id)
      .then((onePager) => {
        if (generation.current !== current) return;
        setBase({ markdown: onePager.markdown, updatedAt: onePager.updated_at });
        setDraft(onePagerFocus(onePager.markdown));
        setLoaded(true);
      })
      .catch((error: unknown) => {
        if (generation.current !== current) return;
        // No ONE_PAGER.md yet is an empty, editable line — the cover's rule —
        // not a failed read.
        if (error instanceof ApiError && error.status === 404) {
          setBase({ markdown: "", updatedAt: 0 });
          setDraft("");
          setLoaded(true);
          return;
        }
        // A 401 is the account gate's to report; it is not a summary error.
        if (error instanceof ApiError && error.status === 401) return;
        setLoadFailed(true);
      })
      .finally(() => {
        if (generation.current !== current) return;
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (!open || !projectId) {
      // Closing (or a list with no project picked) invalidates every answer
      // still in flight.
      generation.current += 1;
      return;
    }
    setDraft("");
    setBase({ markdown: "", updatedAt: 0 });
    load(projectId);
  }, [open, projectId, load]);

  // The editor is an edit, not a reading surface: the field takes the caret
  // once the line has arrived. A frame, because the phone sheet focuses its
  // panel on a timer of its own and would otherwise move focus back.
  useEffect(() => {
    if (!open || !loaded) return;
    const field = fieldRef.current;
    if (!field) return;
    const focus = () => {
      field.focus();
      const end = field.value.length;
      try {
        field.setSelectionRange(end, end);
      } catch {
        // Some browsers refuse selection on a field they did not focus.
      }
    };
    if (typeof requestAnimationFrame === "function") {
      const frame = requestAnimationFrame(focus);
      return () => cancelAnimationFrame(frame);
    }
    focus();
    return undefined;
  }, [open, loaded]);

  const save = async (body: string, from: Base) => {
    if (!projectId) return;
    const current = generation.current;
    setSaving(true);
    setSaveError(null);
    try {
      await putOnePager(
        projectId,
        setOnePagerFocus(from.markdown, body),
        from.updatedAt || undefined,
      );
      if (generation.current !== current) return;
      onClose();
    } catch (error) {
      if (generation.current !== current) return;
      if (error instanceof ApiError && error.status === 409) {
        // Never overwrite silently: fetch the version that won and offer both
        // ways forward.
        try {
          const theirs = await getOnePager(projectId);
          if (generation.current !== current) return;
          setConflict(theirs);
        } catch {
          if (generation.current !== current) return;
          setSaveError(tr("projects.conflict"));
        }
      } else if (error instanceof ApiError && error.status === 401) {
        // The account gate owns this one.
      } else {
        setSaveError(
          error instanceof Error && error.message ? error.message : tr("projects.saveFailed"),
        );
      }
    } finally {
      if (generation.current === current) setSaving(false);
    }
  };

  const takeTheirs = () => {
    if (!conflict) return;
    setBase({ markdown: conflict.markdown, updatedAt: conflict.updated_at });
    setDraft(onePagerFocus(conflict.markdown));
    setConflict(null);
    setSaveError(null);
  };

  const keepMine = (body: string) => {
    if (!conflict) return;
    // Compose on their document, not the stale one: "overwrite" replaces the
    // focus line and leaves their other edits intact.
    void save(body, { markdown: conflict.markdown, updatedAt: conflict.updated_at });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (loaded && !saving && !offline && !conflict) void save(draft, base);
    }
  };

  const label = tr("nav.editSummary");
  const retry = () => {
    if (projectId) load(projectId);
  };

  const footer = open ? (
    <div className="flex w-full items-center justify-end gap-2">
      <Button variant="secondary" className="min-h-11" onClick={onClose}>
        {tr("common.cancel")}
      </Button>
      {conflict ? null : (
        <Button
          variant="default"
          className="min-h-11"
          disabled={!loaded || saving || offline}
          onClick={() => void save(draft, base)}
        >
          {saving ? tr("projects.summarySaving") : tr("common.save")}
        </Button>
      )}
    </div>
  ) : undefined;

  const body = !open ? null : (
    <div className="space-y-3">
      {loadFailed ? (
        <InlineAlert>
          <p>{tr("projects.summaryLoadFailed")}</p>
          <Button variant="secondary" className="mt-2 text-strong" onClick={retry}>
            {tr("common.retry")}
          </Button>
        </InlineAlert>
      ) : !loaded ? (
        <div className="space-y-3 py-2" aria-busy={loading}>
          <SkeletonLine />
          <SkeletonLine />
        </div>
      ) : (
        <>
          <TextArea
            ref={fieldRef}
            label={tr("projects.summaryTitle")}
            value={draft}
            rows={3}
            maxLength={300}
            placeholder={tr("projects.summaryPlaceholder")}
            disabled={offline || saving}
            status={saveError ? { type: "error", message: saveError } : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {offline ? (
            <p className="text-caption text-kin-muted">{tr("projects.summaryOffline")}</p>
          ) : null}
          {conflict ? (
            <InlineAlert>
              <p className="font-medium">{tr("projects.conflictTitle")}</p>
              <p className="mt-1 whitespace-pre-wrap text-strong">
                {conflict.one_pager_summary?.focus ||
                  onePagerFocus(conflict.markdown) ||
                  tr("projects.summaryEmpty")}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button
                  variant="default"
                  disabled={saving}
                  className="text-strong"
                  onClick={() => keepMine(draft)}
                >
                  {tr("projects.conflictKeepMine")}
                </Button>
                <Button variant="secondary" className="text-strong" onClick={takeTheirs}>
                  {tr("projects.conflictTakeTheirs")}
                </Button>
                <Button
                  variant="quiet"
                  className="text-strong"
                  // Dismissing keeps the old base on purpose: the next save
                  // meets the same 409 instead of overwriting the version this
                  // editor has not read.
                  onClick={() => setConflict(null)}
                >
                  {tr("projects.conflictDismiss")}
                </Button>
              </div>
            </InlineAlert>
          ) : null}
        </>
      )}
    </div>
  );

  // One face at a time. The phone (and a coarse tablet at any width) gets the
  // bottom sheet; a Mac gets the dialog. Both are named by the same label.
  return coarse ? (
    <Sheet
      open={open}
      onClose={onClose}
      title={label}
      anyWidth
      footer={footer}
      bodyClassName="pb-2"
    >
      {body}
    </Sheet>
  ) : (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      label={label}
      purpose="form"
      footer={footer}
    >
      {body}
    </Dialog>
  );
}
