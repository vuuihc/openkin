import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { ApiError, patchProject, type Project } from "../../api/client";
import { useCoarsePointer } from "../../hooks/useMediaQuery";
import { useSlowHint } from "../../hooks/useSlowHint";
import { useT } from "../../i18n/react";
import type { Machine } from "../../lib/devices";
import {
  appendProjectRoot,
  makeProjectRootDefault,
  middleEllipsis,
  normalizeProjectRoots,
  removeProjectRoot,
} from "../../lib/projectRoots";
import MachinePicker from "../chat/MachinePicker";
import CwdPicker from "../chat/CwdPicker";
import Sheet, { useSheetLayer } from "../mobile/Sheet";
import Button from "../ui/Button";
import Dialog from "../ui/Dialog";

/**
 * The project's working folders, edited from the project row.
 *
 * This is the cover's `ProjectRootsBlock` editor without the page: the same
 * ordered `roots` list, the same `PATCH /api/projects/:id` that replaces it as
 * a whole, and the same failure contract. The row is where a person already
 * chooses a project, so the editor opens over the list — a bottom sheet on a
 * coarse pointer (an 820 tablet included), a dialog on a Mac — and never
 * navigates to `/projects/:id`.
 *
 * The draft is the unit of change: the list on screen does not move until the
 * daemon has accepted the whole ordered list, a failed save keeps the draft and
 * its reason instead of silently rolling back, and "make default" is "move this
 * folder to the front". The rules themselves are `lib/projectRoots` — this file
 * is the surface, not a second implementation.
 *
 * The last folder cannot be removed here. A row only exists because one of the
 * project's folders is the path it groups, so emptying the list would leave the
 * row with nothing to point at; the confirmation says why and refuses.
 */
type Props = {
  open: boolean;
  /** The local project record behind the row, or null when it has none. */
  project: Project | null;
  offline: boolean;
  machines: Machine[];
  machinesLoading: boolean;
  /** The list installs the daemon's answer, so the row redraws immediately. */
  onProjectChange: (project: Project) => void;
  onClose: () => void;
};

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export default function ProjectRootsEditor({
  open,
  project,
  offline,
  machines,
  machinesLoading,
  onProjectChange,
  onClose,
}: Props) {
  const tr = useT();
  const coarse = useCoarsePointer();
  const projectId = project?.id ?? null;
  const savedRoots = normalizeProjectRoots(project?.roots);

  const [draft, setDraft] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const slow = useSlowHint(saving);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [gone, setGone] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addDevice, setAddDevice] = useState("");

  const saveRef = useRef<HTMLButtonElement | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const cancelRemoveRef = useRef<HTMLButtonElement | null>(null);
  const removeRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  /** The project this editor was opened for; a save answers only for it. */
  const openFor = useRef<string | null>(null);
  /** Newer save or a close wins over an older answer. */
  const saveGen = useRef(0);
  /**
   * The newest saved list, read when the editor opens. The record can be
   * replaced while the editor is closed (the list re-reads projects on a
   * reconnect), but a replacement must not reset a draft that is already being
   * edited, so this is a ref rather than an effect dependency on `roots`.
   */
  const savedRef = useRef(savedRoots);
  useEffect(() => {
    savedRef.current = normalizeProjectRoots(project?.roots);
  }, [project]);

  // The inline confirmation is a layer over the phone sheet, not a second
  // dialog: Back closes it first, Tab stays inside it, and the sheet's own
  // Escape check sees it and leaves the whole sheet open.
  useSheetLayer(pendingRemove !== null, () => setPendingRemove(null));

  const dirty = open && !sameList(draft, savedRoots);
  const lastFolder = draft.length === 1;
  const locked = offline || forbidden || gone;

  const focusLater = useCallback((target: () => HTMLElement | null) => {
    const run = () => target()?.focus();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else run();
  }, []);
  const focusSave = useCallback(() => focusLater(() => saveRef.current), [focusLater]);

  // One generation per open / project. A re-open bumps it, and an answer from
  // the previous generation cannot paint over the newer state.
  useEffect(() => {
    saveGen.current += 1;
    openFor.current = null;
    setSaving(false);
    setError(null);
    setForbidden(false);
    setGone(false);
    setPendingRemove(null);
    setDuplicate(false);
    setAdding(false);
    if (!open || !projectId) {
      setDraft([]);
      return;
    }
    openFor.current = projectId;
    setDraft(savedRef.current);
    setAddDevice("");
  }, [open, projectId]);

  // The confirmation bar takes focus first on its Cancel, so Escape and Enter
  // both have a safe default; the row's Remove gets it back on cancel.
  useEffect(() => {
    if (pendingRemove === null) return;
    const run = () => cancelRemoveRef.current?.focus();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else run();
  }, [pendingRemove]);

  const requestClose = useCallback(() => {
    if (saving) return;
    if (
      dirty &&
      !(typeof window.confirm === "function" ? window.confirm(tr("projects.rootsUnsaved")) : true)
    ) {
      focusSave();
      return;
    }
    onClose();
  }, [dirty, focusSave, onClose, saving, tr]);

  const save = useCallback(async () => {
    const projectId = openFor.current;
    if (!open || !project || saving || locked) return;
    if (!projectId || projectId !== project.id) return;
    const gen = ++saveGen.current;
    const roots = [...draft];
    setSaving(true);
    setError(null);
    try {
      const updated = await patchProject(projectId, { roots });
      // An answer for a closed editor, or one a newer save has replaced, is
      // not this editor's answer. The older save must not win the redraw.
      if (gen !== saveGen.current || openFor.current !== projectId) return;
      if (updated.id !== projectId) return;
      onProjectChange(updated);
      openFor.current = null;
      onClose();
    } catch (e) {
      if (gen !== saveGen.current) return;
      if (e instanceof ApiError && e.status === 403) {
        setForbidden(true);
        setError(tr("projects.rootsForbidden"));
      } else if (e instanceof ApiError && e.status === 404) {
        setGone(true);
        setError(tr("projects.notFound"));
      } else {
        setError(e instanceof Error && e.message ? e.message : tr("projects.rootsSaveFailed"));
      }
      // The draft and the editor stay; the caret goes back to Save so a retry
      // is the next Enter rather than a hunt.
      focusSave();
    } finally {
      if (gen === saveGen.current) setSaving(false);
    }
  }, [draft, focusSave, locked, onClose, onProjectChange, open, project, saving, tr]);

  const cancelRemove = (root: string) => {
    setPendingRemove(null);
    setDuplicate(false);
    focusLater(() => removeRefs.current[root] ?? null);
  };

  const confirmRemove = (root: string) => {
    setDraft((current) => removeProjectRoot(current, root));
    setPendingRemove(null);
    setDuplicate(false);
    focusLater(() => addRef.current);
  };

  const setDefault = (root: string) => {
    setDraft((current) => makeProjectRootDefault(current, root));
    setDuplicate(false);
  };

  const addPath = (candidate: string) => {
    const result = appendProjectRoot(draft, candidate);
    if (result.duplicate) {
      setDuplicate(true);
      return;
    }
    if (sameList(result.roots, draft)) return;
    setDraft(result.roots);
    setDuplicate(false);
    setAdding(false);
    focusLater(() => addRef.current);
  };

  const onEditorKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!((event.metaKey || event.ctrlKey) && event.key === "Enter")) return;
    event.preventDefault();
    event.stopPropagation();
    if (!saving && !locked) void save();
  };

  const onConfirmKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, root: string) => {
    if (event.key !== "Escape") return;
    // The dialog would otherwise treat this Escape as its own and close the
    // whole editor from under a confirmation that has not answered yet.
    event.preventDefault();
    event.stopPropagation();
    cancelRemove(root);
  };

  const suggestions = (() => {
    const machine = machines.find(
      (candidate) => (candidate.isSelf ? "" : candidate.id) === addDevice,
    );
    return machine?.roots ?? [];
  })();

  const saveLabel = saving
    ? slow
      ? tr("projects.rootsStillSaving")
      : tr("projects.rootsSaving")
    : tr("projects.rootsSave");

  const footer = (
    <div className="flex items-center justify-end gap-2" onKeyDown={onEditorKeyDown}>
      <Button variant="quiet" onClick={requestClose} disabled={saving}>
        {tr("common.cancel")}
      </Button>
      <Button
        ref={saveRef}
        variant="default"
        disabled={saving || locked}
        aria-keyshortcuts="Meta+Enter Control+Enter"
        onClick={() => void save()}
        className="min-w-24"
      >
        {saveLabel}
      </Button>
    </div>
  );

  const editorBody = (
    <div onKeyDown={onEditorKeyDown}>
      <p className="px-1 pt-1 text-caption leading-prose text-kin-muted">
        {tr("projects.rootsEditorHelp")}
      </p>
      {offline && (
        <output className="block px-1 pt-1 text-caption text-kin-orange-ink">
          {tr("projects.rootsOffline")}
        </output>
      )}

      {/* Always mounted, so the reason is announced when it changes rather
          than appearing in a region the reader never had. */}
      <div
        aria-live="assertive"
        aria-atomic="true"
        className={
          error
            ? "mx-1 mt-2 rounded-md border-l-2 border-kin-red/40 bg-kin-red/10 px-3 py-2 text-body text-kin-red-ink"
            : ""
        }
      >
        {error && (
          <>
            <p>{error}</p>
            {!forbidden && !gone && (
              <Button
                variant="secondary"
                className="mt-2 text-strong"
                disabled={saving || offline}
                onClick={() => void save()}
              >
                {tr("common.retry")}
              </Button>
            )}
          </>
        )}
      </div>

      {draft.length === 0 ? (
        <p className="px-1 pt-2 text-body text-kin-secondary">{tr("projects.rootsEmpty")}</p>
      ) : (
        <ul className="mt-1 divide-y divide-[var(--kin-hairline)]">
          {draft.map((root, index) => (
            <li key={root} className="py-1.5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span
                  className="min-w-0 flex-initial truncate font-mono text-body leading-ui text-kin-text"
                  title={root}
                >
                  {middleEllipsis(root)}
                </span>
                {index === 0 && (
                  <span className="flex-none rounded-full border border-kin-hairline px-2 py-0.5 text-caption text-kin-secondary">
                    {tr("projects.rootsDefault")}
                  </span>
                )}
                <div className="flex flex-none items-center gap-1">
                  {index !== 0 && (
                    <Button
                      variant="quiet"
                      disabled={saving || locked}
                      onClick={() => setDefault(root)}
                      className="text-caption"
                    >
                      {tr("projects.rootsSetDefault")}
                    </Button>
                  )}
                  <Button
                    ref={(element) => {
                      removeRefs.current[root] = element;
                    }}
                    variant="quiet-danger"
                    disabled={saving || locked}
                    onClick={() => setPendingRemove(root)}
                    className="text-caption"
                  >
                    {tr("projects.rootsRemove")}
                  </Button>
                </div>
              </div>

              {pendingRemove === root && (
                <div
                  role="group"
                  aria-label={tr("projects.rootsRemoveTitle", { path: root })}
                  data-sheet-layer=""
                  onKeyDown={(event) => onConfirmKeyDown(event, root)}
                  className="mt-1 rounded-md border-l-2 border-kin-red/40 bg-kin-red/10 px-3 py-2"
                >
                  <p className="text-body leading-prose text-kin-red-ink">
                    {tr("projects.rootsRemoveConfirm")}
                  </p>
                  {lastFolder && (
                    <p className="mt-1 text-caption leading-prose text-kin-red-ink">
                      {tr("projects.rootsRemoveLast")}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Button
                      ref={cancelRemoveRef}
                      variant="secondary"
                      className="text-strong"
                      onClick={() => cancelRemove(root)}
                    >
                      {tr("common.cancel")}
                    </Button>
                    <Button
                      variant="quiet-danger"
                      disabled={saving || locked || lastFolder}
                      onClick={() => confirmRemove(root)}
                      className="text-strong"
                    >
                      {tr("projects.rootsRemove")}
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {!adding && (
        <div className="px-1 pt-2">
          <Button
            ref={addRef}
            variant="secondary"
            disabled={saving || locked}
            onClick={() => {
              setAdding(true);
              setDuplicate(false);
              setAddDevice("");
            }}
          >
            ＋ {tr("projects.rootsAdd")}
          </Button>
        </div>
      )}

      {adding && (
        <div className="mt-2 rounded-lg bg-[var(--kin-fill)] px-2 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <MachinePicker
              machines={machines}
              value={addDevice === "" ? null : addDevice}
              loading={machinesLoading}
              disabled={saving}
              onChange={(id) => setAddDevice(id ?? "")}
            />
            <CwdPicker
              cwd=""
              compact
              device={addDevice || undefined}
              suggestions={suggestions}
              onChange={addPath}
            />
          </div>
          <div className="mt-1 flex items-center justify-between gap-2">
            <output className="text-caption text-kin-orange-ink">
              {duplicate ? tr("projects.rootsAddDuplicate") : ""}
            </output>
            <Button
              variant="quiet"
              onClick={() => {
                setAdding(false);
                setDuplicate(false);
                focusLater(() => addRef.current);
              }}
              className="text-caption"
            >
              {tr("common.close")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );

  const isOpen = open && project !== null;
  // Nothing is drawn while the editor is closed: an always-mounted picker
  // would keep a second draft (and its folder browser) alive under the list.
  const body = isOpen ? editorBody : null;

  // One face at a time. The phone (and a coarse tablet at any width) gets the
  // bottom sheet; a Mac gets the dialog. Both are named by the same label.
  return coarse ? (
    <Sheet
      open={isOpen}
      onClose={requestClose}
      title={tr("projects.rootsTitle")}
      anyWidth
      footer={isOpen ? footer : undefined}
      bodyClassName="pb-2"
    >
      {body}
    </Sheet>
  ) : (
    <Dialog
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
      label={tr("projects.rootsTitle")}
      purpose="form"
      footer={isOpen ? footer : undefined}
    >
      {body}
    </Dialog>
  );
}
