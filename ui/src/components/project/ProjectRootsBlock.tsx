import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Link } from "react-router-dom";
import { ApiError, patchProject, type Project } from "../../api/client";
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
import Sheet, { useSheetLayer } from "../mobile/Sheet";
import MachinePicker from "../chat/MachinePicker";
import CwdPicker from "../chat/CwdPicker";
import Button from "../ui/Button";
import Popover from "../ui/Popover";

/**
 * "Working folders" on the project cover (KIN-PROJECT-002).
 *
 * The project record already owns an ordered `roots` list, and `PATCH
 * /api/projects/:id` replaces it as a whole. The cover's job is to make that
 * list legible: every folder in saved order, the first one marked default,
 * because that is where a new chat lands. Editing happens in a draft — the
 * cover does not move until the daemon has accepted the whole list — and a
 * failed save keeps the draft and its reason instead of silently rolling back.
 *
 * The two surfaces are the console's own: a Mac gets the anchored `Popover`
 * over the block, a phone gets the bottom `Sheet` with its Save in the footer.
 * Adding a folder reuses the new-chat pickers (`MachinePicker` → `CwdPicker`)
 * instead of inventing a second folder browser.
 */
type Props = {
  project: Project;
  offline: boolean;
  wide: boolean;
  machines: Machine[];
  machinesLoading: boolean;
  /** The machine that owns the project folder; "" is this console's daemon. */
  device: string;
  /** The page installs the daemon's answer, so the cover redraws immediately. */
  onProjectChange: (project: Project) => void;
  /** Lets the page keep ⌘Enter and the phone CTA from firing under the editor. */
  onEditingChange: (editing: boolean) => void;
};

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export default function ProjectRootsBlock({
  project,
  offline,
  wide,
  machines,
  machinesLoading,
  device,
  onProjectChange,
  onEditingChange,
}: Props) {
  const tr = useT();
  const titleId = useId();
  const panelId = useId();
  const savedRoots = normalizeProjectRoots(project.roots);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(savedRoots);
  const [saving, setSaving] = useState(false);
  const slow = useSlowHint(saving);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [gone, setGone] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addDevice, setAddDevice] = useState(device);

  const editRef = useRef<HTMLButtonElement | null>(null);
  const saveRef = useRef<HTMLButtonElement | null>(null);
  const addRef = useRef<HTMLButtonElement | null>(null);
  const cancelRemoveRef = useRef<HTMLButtonElement | null>(null);
  const removeRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  /** The project this editor was opened for; a save answers only for it. */
  const openFor = useRef<string | null>(null);
  /** Newer save or a route change wins over an older answer. */
  const saveGen = useRef(0);

  // The inline confirmation is a layer over the phone sheet, not a second
  // dialog: Back closes it first, Tab stays inside it, and the sheet's own
  // Escape check sees it and leaves the whole sheet open.
  useSheetLayer(pendingRemove !== null, () => setPendingRemove(null));

  const dirty = editing && !sameList(draft, savedRoots);
  const locked = offline || forbidden || gone;

  const focusLater = useCallback((target: () => HTMLElement | null) => {
    const run = () => target()?.focus();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else run();
  }, []);
  const focusEdit = useCallback(() => focusLater(() => editRef.current), [focusLater]);
  const focusSave = useCallback(() => focusLater(() => saveRef.current), [focusLater]);

  useEffect(() => {
    onEditingChange(editing);
  }, [editing, onEditingChange]);

  // Another project is another list. Any answer still in flight belongs to the
  // cover that asked and must not install itself into this one.
  useEffect(() => {
    saveGen.current += 1;
    openFor.current = null;
    setEditing(false);
    setDraft([]);
    setSaving(false);
    setError(null);
    setForbidden(false);
    setGone(false);
    setPendingRemove(null);
    setDuplicate(false);
    setAdding(false);
  }, [project.id]);

  // The confirmation bar takes focus first on its Cancel, so Escape and Enter
  // both have a safe default; the row's Remove gets it back on cancel.
  useEffect(() => {
    if (pendingRemove === null) return;
    const run = () => cancelRemoveRef.current?.focus();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else run();
  }, [pendingRemove]);

  const beginEdit = () => {
    if (locked) return;
    saveGen.current += 1;
    openFor.current = project.id;
    setDraft(savedRoots);
    setError(null);
    setForbidden(false);
    setGone(false);
    setPendingRemove(null);
    setDuplicate(false);
    setAdding(false);
    setAddDevice(device);
    setEditing(true);
  };

  const requestClose = useCallback(() => {
    if (saving) return;
    if (
      dirty &&
      !(typeof window.confirm === "function" ? window.confirm(tr("projects.rootsUnsaved")) : true)
    ) {
      focusSave();
      return;
    }
    setEditing(false);
    setError(null);
    setPendingRemove(null);
    setDuplicate(false);
    setAdding(false);
    focusEdit();
  }, [dirty, focusEdit, focusSave, saving, tr]);

  const save = useCallback(async () => {
    const projectId = openFor.current;
    if (!editing || saving || locked) return;
    if (!projectId || projectId !== project.id) return;
    const gen = ++saveGen.current;
    const roots = [...draft];
    setSaving(true);
    setError(null);
    try {
      const updated = await patchProject(projectId, { roots });
      // An answer for another route, or one a newer save has replaced, is not
      // this editor's answer. The older save must not win the redraw.
      if (gen !== saveGen.current || openFor.current !== projectId) return;
      if (updated.id !== projectId) return;
      onProjectChange(updated);
      openFor.current = null;
      setEditing(false);
      setPendingRemove(null);
      setAdding(false);
      focusEdit();
    } catch (e) {
      if (gen !== saveGen.current) return;
      if (e instanceof ApiError && e.status === 404) {
        setGone(true);
      } else if (e instanceof ApiError && e.status === 403) {
        setForbidden(true);
        setError(tr("projects.rootsForbidden"));
      } else {
        setError(e instanceof Error && e.message ? e.message : tr("projects.rootsSaveFailed"));
      }
      // The draft and the sheet stay; the caret goes back to Save so a retry
      // is the next Enter rather than a hunt.
      focusSave();
    } finally {
      if (gen === saveGen.current) setSaving(false);
    }
  }, [draft, editing, focusEdit, focusSave, locked, onProjectChange, project.id, saving, tr]);

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
    // The popover would otherwise treat this Escape as its own and close the
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
      {wide && (
        <h3 className="px-1 text-subtitle font-semibold text-kin-text">
          {tr("projects.rootsTitle")}
        </h3>
      )}
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
          error || gone
            ? "mx-1 mt-2 rounded-md border-l-2 border-kin-red/40 bg-kin-red/10 px-3 py-2 text-body text-kin-red-ink"
            : ""
        }
      >
        {error && !gone && (
          <>
            <p>{error}</p>
            <Button
              variant="secondary"
              className="mt-2 text-strong"
              disabled={saving || offline || forbidden || gone}
              onClick={() => void save()}
            >
              {tr("common.retry")}
            </Button>
          </>
        )}
        {gone && (
          <>
            <p>{tr("projects.notFound")}</p>
            <Link
              to="/projects"
              className="mt-2 inline-flex min-h-11 items-center text-body text-strong underline"
            >
              {tr("projects.title")}
            </Link>
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
                  className="min-w-0 flex-1 break-all font-mono text-body leading-ui text-kin-text"
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
                  <Button
                    variant="quiet"
                    disabled={index === 0 || saving || locked}
                    onClick={() => setDefault(root)}
                    className="text-caption"
                  >
                    {index === 0 ? tr("projects.rootsIsDefault") : tr("projects.rootsSetDefault")}
                  </Button>
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
                  {draft.length === 1 && (
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
              setAddDevice(device);
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

  return (
    <section aria-labelledby={titleId} className="mb-4 rounded-xl bg-kin-panel p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2
          id={titleId}
          className="text-body font-medium uppercase tracking-label text-kin-secondary"
        >
          {tr("projects.rootsTitle")}
        </h2>
        {savedRoots.length > 0 && (
          <Button
            ref={editRef}
            variant="secondary"
            disabled={offline}
            aria-haspopup="dialog"
            aria-expanded={editing}
            className="text-strong"
            onClick={beginEdit}
          >
            {tr("projects.rootsEdit")}
          </Button>
        )}
      </div>

      {savedRoots.length === 0 ? (
        <div>
          <p className="text-body text-kin-secondary">{tr("projects.rootsEmpty")}</p>
          <Button
            ref={editRef}
            variant="secondary"
            disabled={offline}
            aria-haspopup="dialog"
            aria-expanded={editing}
            className="mt-2 text-strong"
            onClick={beginEdit}
          >
            ＋ {tr("projects.rootsAdd")}
          </Button>
        </div>
      ) : (
        <>
          <p className="mb-1 text-caption leading-prose text-kin-muted">
            {savedRoots.length === 1 ? tr("projects.rootsRuleOne") : tr("projects.rootsRule")}
          </p>
          <ul className="space-y-1">
            {savedRoots.map((root, index) => {
              const shown = middleEllipsis(root, wide ? 64 : 40);
              return (
                <li key={root} className="flex min-w-0 items-baseline gap-2 py-0.5">
                  <span
                    className="min-w-0 flex-1 break-all font-mono text-body leading-ui text-kin-text"
                    title={root}
                  >
                    {shown === root ? (
                      root
                    ) : (
                      <>
                        <span aria-hidden="true">{shown}</span>
                        <span className="sr-only">{root}</span>
                      </>
                    )}
                  </span>
                  {index === 0 && (
                    <span className="flex-none rounded-full border border-kin-hairline px-2 py-0.5 text-caption text-kin-secondary">
                      {tr("projects.rootsDefault")}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}

      {offline && (
        <output className="mt-2 block text-caption text-kin-muted">
          {tr("projects.rootsOffline")}
        </output>
      )}

      {wide ? (
        <Popover
          open={editing}
          onOpenChange={(next) => {
            if (!next) requestClose();
          }}
          triggerRef={editRef}
          label={tr("projects.rootsTitle")}
          id={panelId}
          align={savedRoots.length === 0 ? "left" : "right"}
          placement="below"
          width={440}
          maxHeight={560}
          padded={false}
          className="p-3"
        >
          {editorBody}
          <div className="mt-3 border-t border-kin-hairline px-1 pt-2">{footer}</div>
        </Popover>
      ) : (
        <Sheet
          open={editing}
          onClose={requestClose}
          title={tr("projects.rootsTitle")}
          footer={footer}
        >
          {editorBody}
        </Sheet>
      )}
    </section>
  );
}
