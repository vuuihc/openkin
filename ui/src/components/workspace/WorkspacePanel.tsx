import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  getTaskSourceChanges,
  getWorkspaceDiff,
  listTaskWorkspaces,
  type TaskEvent,
  type TaskWorkspaceFileResponse,
  type WorkspaceFileResponse,
  type WorkspaceGeneration,
} from "../../api/client";
import { t } from "../../i18n";
import { useT } from "../../i18n/react";
import {
  changedFilesFromDiff,
  extractChangedFiles,
  extractFileDiff,
  sourceChangesFor,
  summarizeChangedFiles,
  type ChangedFile,
  type FileDiffSnippet,
} from "../../lib/changedFiles";
import WorkspaceGenerationPicker from "./WorkspaceGenerationPicker";
import { projectLabel, shortPath, toWorkspaceRelativePath } from "../../lib/paths";
import { IconBack, IconPanel, IconSearch, IconSend, IconSpinner, IconX } from "../icons";
import Button from "../ui/Button";
import Tabs from "../ui/Tabs";
import DeltaInline from "../changedFileFace";
import ChangedFilesList from "./ChangedFilesList";
import FileTree from "./FileTree";

import {
  effectiveCurrentWorkspaceID,
  readWorkspaceViewFile,
  resolveWorkspaceView,
  workspaceLifecycleRefreshKey,
  workspaceViewKey,
  workspaceViewFileBytesURL,
} from "./workspaceView";
import { DelimitedTablePane, DownloadPreview, ImagePreview } from "./FilePreview";
import { previewKind, workspaceErrorMessage } from "./workspacePreview";
import { lensForPick } from "../../lib/workspaceLens";
import { useAppStore } from "../../store/appStore";

// CodeViewer is the only thing that pulls in monaco-editor, which is by far the
// heaviest dependency in the bundle: the editor plus five language workers.
// Importing it statically put all of that in the entry chunk, so opening the
// console on a phone downloaded a code editor before it could show a session
// list. Split out and loaded once a file is opened, the way MermaidBlock
// already handles mermaid.
const CodeViewer = lazy(() => import("./CodeViewer"));

type Props = {
  taskId: string;
  cwd: string;
  openPath?: string | null;
  /** Bumps each time the user re-opens a path (even the same one). */
  openNonce?: number;
  onClose?: () => void;
  /** Task event stream — used to reconstruct edit diffs for highlighting. */
  events?: TaskEvent[];
  /**
   * Optional precomputed changed-file list. When omitted, derived from events.
   */
  changedFiles?: ChangedFile[];
  /** Currently selected workspace generation ID (null = source / current project). */
  selectedWorkspaceId?: string | null;
  currentWorkspaceId?: string | null;
  /** Called when the user picks a different workspace generation. */
  onSelectWorkspace?: (id: string | null) => void;
  /** Isolated terminal task: enable keep/discard review actions. */
  reviewActions?: boolean;
  onDiscardAll?: () => void | Promise<void>;
  actionsBusy?: boolean;
  /**
   * Opens the publish sheet, for a task whose checkout is on another machine.
   *
   * Omitted means this console has nothing to publish here — the session runs on
   * the machine showing the page, where the person can push the branch
   * themselves, and the Hub refuses the write for exactly that reason.
   */
  onPublish?: () => void;
  /**
   * Opens the file finder, for a console that has one.
   *
   * The shortcut is the desktop's; this button is how a phone reaches the same
   * surface, next to the two lenses it searches past.
   */
  onFindFile?: () => void;
};

const SIDEBAR_WIDTH_KEY = "kin.workspace.sidebarWidth";
const DEFAULT_SIDEBAR_WIDTH = 320;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 560;
/**
 * The narrowest container that can hold both panes.
 *
 * The split is asked of the panel's own width, not the viewport's: the same
 * component is a 380px column beside the conversation on a wide screen and the
 * whole screen on a phone, so `md:` is the wrong question — a 380px column at
 * a 1280px viewport would take a 320px sidebar and leave the viewer 54px.
 * Below this the two panes stack and the back button returns.
 */
const SPLIT_MIN_WIDTH = 640;
/**
 * How long a burst of file-touching events is allowed to settle before the
 * source view asks the machine for git's answer. Long enough that one turn's
 * edits are one question, short enough that the list is there by the time
 * somebody looks up from the transcript.
 */
const SOURCE_CHANGES_DEBOUNCE_MS = 400;

type DragState = {
  pointerId: number;
  startX: number;
  startWidth: number;
};

type WorkspaceGenerationResource = {
  taskId: string;
  refreshKey: string;
  generations: WorkspaceGeneration[];
  loading: boolean;
};

function readStoredSidebarWidth(): number {
  try {
    const raw = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (!raw) return DEFAULT_SIDEBAR_WIDTH;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_SIDEBAR_WIDTH;
    return clampSidebarWidth(n);
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function clampSidebarWidth(value: number, containerWidth?: number): number {
  let max = MAX_SIDEBAR_WIDTH;
  if (containerWidth && containerWidth > 0) {
    // Keep at least ~280px for the viewer.
    max = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, containerWidth - 280));
  }
  return Math.min(max, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)));
}

/**
 * Full-panel workspace browser: sticky dual-pane layout.
 * Left = changed-files list or full tree (switchable);
 * Right = file / diff viewer. Switching files never leaves the dual pane.
 */
export default function WorkspacePanel({
  taskId,
  cwd,
  openPath,
  openNonce,
  onClose,
  events,
  changedFiles: changedFilesProp,
  selectedWorkspaceId,
  currentWorkspaceId,
  onSelectWorkspace,
  reviewActions = false,
  onDiscardAll,
  actionsBusy = false,
  onPublish,
  onFindFile,
}: Props) {
  useT();
  const tr = useT();
  // Which lens is in front: a pick made for this exact place, else the default.
  // The pick is store state rather than local, so anything that means "show me
  // the changes" can name the lens instead of opening the panel and trusting the
  // default to agree — see `lib/workspaceLens`.
  const lensPick = useAppStore((s) => s.lensPick);
  const pickWorkspaceLens = useAppStore((s) => s.pickWorkspaceLens);
  const generationRefreshKey = workspaceLifecycleRefreshKey(events, currentWorkspaceId);
  const [generationResource, setGenerationResource] = useState<WorkspaceGenerationResource>(() => ({
    taskId,
    refreshKey: generationRefreshKey,
    generations: [],
    loading: true,
  }));
  const generationResourceCurrent =
    generationResource.taskId === taskId && generationResource.refreshKey === generationRefreshKey;
  const generations = generationResourceCurrent ? generationResource.generations : [];
  const generationsLoading = !generationResourceCurrent || generationResource.loading;
  const effectiveCurrentWorkspaceId = effectiveCurrentWorkspaceID(currentWorkspaceId, generations);

  useEffect(() => {
    let cancelled = false;
    setGenerationResource({
      taskId,
      refreshKey: generationRefreshKey,
      generations: [],
      loading: true,
    });
    listTaskWorkspaces(taskId)
      .then((nextGenerations) => {
        if (cancelled) return;
        setGenerationResource({
          taskId,
          refreshKey: generationRefreshKey,
          generations: nextGenerations,
          loading: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setGenerationResource({
          taskId,
          refreshKey: generationRefreshKey,
          generations: [],
          loading: false,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, generationRefreshKey]);

  const workspaceView = useMemo(
    () => resolveWorkspaceView(selectedWorkspaceId, effectiveCurrentWorkspaceId, generations),
    [selectedWorkspaceId, effectiveCurrentWorkspaceId, generations],
  );
  const viewedWorkspaceId = workspaceView.kind === "generation" ? workspaceView.workspaceId : null;
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Below `md` the panel is one pane at a time: the list, then a full-height
  // file. Stacking them left a diff with roughly half a phone screen while the
  // list that led to it held the rest. On md+ both panes are shown side by side
  // and this only remembers which one a phone would be looking at.
  const [phoneView, setPhoneView] = useState<"list" | "file">("list");
  const [file, setFile] = useState<TaskWorkspaceFileResponse | WorkspaceFileResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A table is a reading view; the source is one click away, and that click is
  // the whole state. Reset by opening another file or place.
  const [tableAsCode, setTableAsCode] = useState(false);
  // Reopening a file is a request to look again. The text read answers by
  // fetching, but an image or a download fetches in its own effect, so it needs
  // something that changes even when the path does not.
  const [previewNonce, setPreviewNonce] = useState(0);
  const [dismissedPaths, setDismissedPaths] = useState<Set<string>>(() => new Set());
  const [genDiffFiles, setGenDiffFiles] = useState<ChangedFile[]>([]);
  const [genDiffLoaded, setGenDiffLoaded] = useState(false);
  const [sourceChanges, setSourceChanges] = useState<{
    taskId: string;
    files: ChangedFile[];
    truncated: boolean;
  } | null>(null);
  const requestRef = useRef(0);
  // The pane the phone is looking at and the two elements focus follows when it
  // changes: the way back, and the list the file was opened from.
  const asideRef = useRef<HTMLElement | null>(null);
  const backRef = useRef<HTMLButtonElement | null>(null);

  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth);
  const sidebarWidthRef = useRef(sidebarWidth);
  const dragRef = useRef<DragState | null>(null);
  const panesRef = useRef<HTMLDivElement>(null);
  // Whether this panel's container is wide enough for both panes. Measured on
  // the element rather than read from the viewport: inside `PanelSurface`'s
  // 380px column the viewport is wide while the panel is not. The initial
  // answer is "wide" — the no-layout fallback `useMinWidth` also uses — and the
  // layout effect corrects it before the first paint.
  const [panesWide, setPanesWide] = useState(true);
  useLayoutEffect(() => {
    const el = panesRef.current;
    if (!el) return;
    const apply = () => {
      const width = el.clientWidth;
      // Zero means nothing has been laid out (or the platform cannot
      // measure); keep the wide answer instead of flashing the phone shape.
      setPanesWide(width === 0 || width >= SPLIT_MIN_WIDTH);
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  sidebarWidthRef.current = sidebarWidth;

  const persistSidebarWidth = useCallback((value: number) => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(value));
    } catch {
      // best-effort
    }
  }, []);

  const updateSidebarWidth = useCallback(
    (value: number, persist = false) => {
      const container = panesRef.current?.clientWidth;
      const next = clampSidebarWidth(value, container);
      sidebarWidthRef.current = next;
      setSidebarWidth(next);
      if (persist) persistSidebarWidth(next);
      return next;
    },
    [persistSidebarWidth],
  );

  // Fetch generation-aware diff for the effective view, including auto mode.
  useEffect(() => {
    if (!viewedWorkspaceId) {
      setGenDiffFiles([]);
      return;
    }
    let cancelled = false;
    setGenDiffLoaded(false);
    getWorkspaceDiff(taskId, viewedWorkspaceId)
      .then((res) => {
        if (cancelled) return;
        setGenDiffFiles(
          changedFilesFromDiff(
            res.workspace_id ?? viewedWorkspaceId,
            res.generation ?? 0,
            res.changes,
          ),
        );
      })
      .catch(() => {
        if (cancelled) return;
        setGenDiffFiles([]);
      })
      .finally(() => {
        if (!cancelled) setGenDiffLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [taskId, viewedWorkspaceId]);

  // A signal that changes when the agent reports touching a file, rather than on
  // every token of a streamed answer. The source fetch below is a `git status`
  // run by the machine holding the checkout — cheap, but not something to ask
  // for once per token.
  const mutationKey = useMemo(() => {
    const files = changedFilesProp ?? extractChangedFiles(events ?? []);
    let newest = 0;
    for (const touched of files) {
      if (touched.seq > newest) newest = touched.seq;
    }
    return `${files.length}:${newest}`;
  }, [changedFilesProp, events]);

  // Fetch the live changes of a shared checkout, which is what the source view
  // shows: git's own answer about the task's directory, asked afresh as the
  // agent reports work. The event stream's reconstruction of the same thing is
  // what the agent said it touched — a good record, and not what the checkout
  // looks like — so it is the fallback here rather than the source.
  //
  // The debounce is what keeps that honest without being expensive: an agent
  // writing twenty files in a burst asks once, not twenty times.
  useEffect(() => {
    if (viewedWorkspaceId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getTaskSourceChanges(taskId)
        .then((res) => {
          if (cancelled) return;
          setSourceChanges({
            taskId,
            files: changedFilesFromDiff(null, null, res.changes),
            truncated: res.truncated === true,
          });
        })
        .catch(() => {
          // The last answer stands, and before any answer the event stream's
          // list is what there is. A checkout git cannot describe — not a
          // repository, or a machine that is away — is not an empty checkout.
        });
    }, SOURCE_CHANGES_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [taskId, viewedWorkspaceId, mutationKey]);

  const changedFiles = useMemo(() => {
    // Whatever the API last answered with is the source of truth: a generation's
    // diff when one is in view, git's own list for a shared checkout.
    if (viewedWorkspaceId && genDiffLoaded) return genDiffFiles;
    const mine = sourceChangesFor(sourceChanges, taskId);
    if (!viewedWorkspaceId && mine) {
      return mine.files;
    }
    if (changedFilesProp) return changedFilesProp;
    if (!events || events.length === 0) return [] as ChangedFile[];
    return extractChangedFiles(events);
  }, [
    changedFilesProp,
    events,
    viewedWorkspaceId,
    genDiffFiles,
    genDiffLoaded,
    sourceChanges,
    taskId,
  ]);

  const visibleChangedFiles = useMemo(
    () =>
      changedFiles.filter(
        (f) => f.action !== "read" && f.action !== "other" && !dismissedPaths.has(f.path),
      ),
    [changedFiles, dismissedPaths],
  );
  const hasChanges = visibleChangedFiles.length > 0;

  const changedFilesKey = useMemo(
    () =>
      changedFiles
        .map((f) => `${f.action}:${f.path}:${f.seq}`)
        .sort()
        .join("|"),
    [changedFiles],
  );
  useEffect(() => {
    setDismissedPaths(new Set());
  }, [changedFilesKey]);

  // The two lenses are one panel seen two ways, so the lens is a property of the
  // place being looked at, not of the panel instance: `workspaceViewKey` is that
  // place, and it is what makes switching generation forget a manual pick while
  // coming back to a place finds it again.
  const viewKey = workspaceViewKey(workspaceView);
  const lens = lensForPick(lensPick, taskId, viewKey, hasChanges);

  // A round begins at the user message that asked for it; the daemon's
  // `round_changed` record names the same seq as `to_seq` on worktree tasks.
  // What the current round touched is read from the file tools after that
  // boundary — the same source the round card uses for the newest round,
  // because no closing record exists for it yet (and shared checkouts write no
  // record at all). See `currentRoundPaths`.
  //
  // The panel's list is the checkout's live answer, so a scope can only narrow
  // it to paths the round names. "Branch" and "uncommitted" as further scopes
  // would be this same list under another word, which is why they are not
  // offered (the precedent is `RunConfigSheet`'s deliberately absent effort).
  const [turnOnly, setTurnOnly] = useState(false);
  const turnFiles = useMemo(() => {
    const paths = currentRoundPaths(events);
    if (!paths) return null;
    const wanted = new Set(
      paths.map((path) => workspacePathKey(cwd, path)).filter((key): key is string => key !== null),
    );
    if (wanted.size === 0) return null;
    return visibleChangedFiles.filter((file) => {
      const key = workspacePathKey(cwd, file.path);
      return key !== null && wanted.has(key);
    });
  }, [cwd, events, visibleChangedFiles]);
  // A scope that cannot change the list is worse than none: only offer the
  // round when it covers some, but not all, of what the list shows. The
  // snapshot view is excluded because a generation's diff is not this task's
  // current round — "this round" is a fact about the checkout, not a snapshot.
  const scopeAvailable =
    !viewedWorkspaceId &&
    turnFiles !== null &&
    turnFiles.length > 0 &&
    turnFiles.length < visibleChangedFiles.length;
  // A scope that stopped being available must not re-apply itself when it
  // comes back: only a press turns the round filter on.
  useEffect(() => {
    if (!scopeAvailable) setTurnOnly(false);
  }, [scopeAvailable]);
  const showingTurn = turnOnly && scopeAvailable && lens === "changes";
  const summaryFiles = showingTurn && turnFiles ? turnFiles : visibleChangedFiles;
  const summaryStats = summarizeChangedFiles(summaryFiles);

  const loadFile = useCallback(
    async (path: string) => {
      // Two things feed the viewer and they speak different dialects: the tree
      // names files relative to the workspace, and the change list carries what
      // the tool reported — claude-code and the ACP adapters report absolute
      // paths. The file API is rooted at the workspace and refuses an absolute
      // one, so a change row opened the file as a 400 and printed the daemon's
      // complaint instead. Inside the workspace the two forms name the same
      // file; anything else is not readable here and says so.
      const readPath = toWorkspaceRelativePath(cwd, path);
      // Bumped before the early return too: a request still in flight must not
      // land on top of the refusal and draw a file the reader did not open.
      const reqID = ++requestRef.current;
      setSelectedPath(path);
      setTableAsCode(false);
      // Every way into a file ends here — the change list, the tree, quick-open,
      // the changed-files bar. A phone shows the file from now on, including
      // the path this refuses: the refusal is the viewer's answer and belongs
      // where the file would have been.
      setPhoneView("file");
      // The row or control that asked for the file is off the phone's screen
      // now, so the browser would drop focus to <body> and the next Tab would
      // start at the top of the page behind this panel. At md+ the back control
      // is not drawn and `focus()` on a hidden element does nothing, which is
      // right there: the list never left.
      requestAnimationFrame(() => backRef.current?.focus());
      if (!readPath) {
        setFile(null);
        setLoading(false);
        setError(t("workspace.viewer.readFailed"));
        return;
      }
      setLoading(true);
      setError(null);
      const kind = previewKind(readPath);
      if (kind === "image" || kind === "binary") {
        // These are not read as text: an image is not UTF-8 and the daemon
        // refuses it, and a binary has nothing to show in an editor. Their
        // bytes are fetched by the viewer itself, which is also what keeps a
        // large file out of memory until it is drawn — or saved.
        setFile(null);
        setLoading(false);
        setPreviewNonce((nonce) => nonce + 1);
        return;
      }
      try {
        const next = await readWorkspaceViewFile(workspaceView, taskId, readPath);
        if (requestRef.current !== reqID) return;
        setFile(next);
      } catch (err) {
        if (requestRef.current !== reqID) return;
        setFile(null);
        setError(workspaceErrorMessage(err, t("workspace.viewer.readFailed")));
      } finally {
        if (requestRef.current === reqID) {
          setLoading(false);
        }
      }
    },
    [cwd, taskId, workspaceView],
  );

  useEffect(() => {
    requestRef.current += 1;
    setSelectedPath(null);
    // A different place is a different list: a phone that was reading a file
    // from the old one starts from the list again.
    setPhoneView("list");
    setFile(null);
    setLoading(false);
    setError(null);
    setTableAsCode(false);
    setGenDiffFiles([]);
    setSourceChanges(null);
    // A different place is a different list, and a scope over the old one says
    // nothing about it.
    setTurnOnly(false);
  }, [cwd, taskId, workspaceView.kind, workspaceView.workspaceId]);

  // The parent's "open this file" is a one-shot command, not a condition, and
  // the path plus the nonce the parent bumps is its identity. It has to be
  // consumed once: `loadFile` takes a new identity whenever the workspace view
  // does — a generation refresh hands back a fresh `generations` array while it
  // loads — and re-running the command then would drag a reader who pressed
  // Back straight into the file again, or reopen a file the new checkout does
  // not have.
  const handledPulseRef = useRef<{ path: string; nonce: number | undefined } | null>(null);
  useEffect(() => {
    if (!openPath) {
      // No pulse pending. Clearing here keeps the dedupe local to this ref
      // rather than leaning on the panel unmounting when it closes.
      handledPulseRef.current = null;
      return;
    }
    const handled = handledPulseRef.current;
    if (handled && handled.path === openPath && handled.nonce === openNonce) return;
    handledPulseRef.current = { path: openPath, nonce: openNonce };
    void loadFile(openPath);
  }, [openPath, openNonce, loadFile]);

  // What the viewer shows comes from the file's name, and the bytes of an
  // image or a download come from the byte routes rather than the text one.
  // The path is workspace-relative, the same form `loadFile` reads with.
  const preview = selectedPath ? previewKind(selectedPath) : "text";
  const fileBytes = useMemo(() => {
    if (!selectedPath || (preview !== "image" && preview !== "binary")) return null;
    const rel = toWorkspaceRelativePath(cwd, selectedPath);
    if (!rel) return null;
    return {
      preview: workspaceViewFileBytesURL(workspaceView, taskId, rel, "preview"),
      download: workspaceViewFileBytesURL(workspaceView, taskId, rel, "download"),
    };
  }, [selectedPath, preview, cwd, workspaceView, taskId]);

  const diff: FileDiffSnippet | null = useMemo(() => {
    if (!selectedPath || !events || events.length === 0) return null;
    return extractFileDiff(events, selectedPath);
  }, [events, selectedPath]);

  // When we have a str_replace snippet and the live file, reconstruct a better
  // original by reverse-applying the replacement against the current content.
  const enrichedDiff = useMemo(() => {
    if (!diff) return null;
    if (diff.source === "str_replace" && file?.content && diff.original && diff.modified) {
      if (file.content.includes(diff.modified)) {
        const idx = file.content.indexOf(diff.modified);
        const originalFull =
          file.content.slice(0, idx) +
          diff.original +
          file.content.slice(idx + diff.modified.length);
        if (originalFull !== file.content) {
          return {
            ...diff,
            original: originalFull,
            modified: file.content,
          };
        }
      }
      return diff;
    }
    if (diff.source === "write" && file?.content) {
      return { ...diff, modified: file.content };
    }
    return diff;
  }, [diff, file]);

  // Back to the list. The button that had focus leaves the screen with the
  // pane, so focus goes to the row that opened the file — the place the reader
  // left off — and that row is scrolled back into view, because hiding the pane
  // also reset the list's scroll.
  const goBackToFiles = () => {
    setPhoneView("list");
    requestAnimationFrame(() => {
      const aside = asideRef.current;
      if (!aside) return;
      // The row that opened the file when the list still knows it; otherwise
      // the lens tab, so focus lands inside the list rather than on <body>.
      const target =
        aside.querySelector<HTMLElement>('[data-selected="true"]') ??
        aside.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      target?.focus();
      target?.scrollIntoView({ block: "nearest" });
    });
  };

  return (
    <div className="h-full min-h-0 flex flex-col bg-[var(--kin-inspector)]">
      <div className="flex-none flex items-center gap-2 border-b border-[var(--kin-hairline)] px-3 py-2">
        {/* The narrow container's way back to the list. A wide container shows
            both panes at once, so there is nothing to go back to and the
            control is not drawn. */}
        {phoneView === "file" && !panesWide && (
          <Button
            ref={backRef}
            variant="quiet"
            onClick={goBackToFiles}
            title={tr("workspace.backToFiles")}
            aria-label={tr("workspace.backToFiles")}
            className="flex-none -ml-1 h-11 w-11 items-center justify-center p-0 text-kin-muted"
          >
            <IconBack size={16} />
          </Button>
        )}
        <IconPanel size={14} className="text-kin-muted flex-none" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-body font-semibold text-kin-text truncate">
              {tr("workspace.title")}
            </span>
            {onSelectWorkspace && (
              <WorkspaceGenerationPicker
                generations={generations}
                loading={generationsLoading}
                selectedId={viewedWorkspaceId}
                onChange={onSelectWorkspace}
              />
            )}
          </div>
          <div className="text-caption text-kin-muted font-mono truncate" title={cwd}>
            {projectLabel(cwd)} · {shortPath(cwd, 48)}
          </div>
        </div>
        {/*
          The one write this panel offers, in the corner of the header it belongs
          in: what the panel shows is a session's changes, and publishing is what
          a person does about them when they are done reading.
        */}
        {onPublish && (
          <Button
            variant="secondary"
            onClick={onPublish}
            title={tr("publish.hint")}
            aria-label={tr("publish.action")}
            className="flex-none gap-1.5 px-2 py-1 text-caption"
          >
            <IconSend size={12} />
            {tr("publish.action")}
          </Button>
        )}
        {workspaceView.editable && reviewActions && onDiscardAll && (
          <Button
            variant="secondary"
            disabled={actionsBusy || !hasChanges}
            onClick={() => void onDiscardAll()}
            title={tr("workspace.changed.discardAllHint")}
            className="md:min-h-0 md:px-2.5 md:py-1 text-caption"
          >
            {tr("workspace.changed.discardAll")}
          </Button>
        )}
        {onClose && (
          <Button
            variant="quiet"
            onClick={onClose}
            className="flex-none h-11 w-11 items-center justify-center p-0 text-kin-muted sm:h-6 sm:w-6"
            aria-label={tr("workspace.close")}
          >
            <IconX size={14} />
          </Button>
        )}
      </div>

      {/* Dual pane: sidebar (list/tree) | resizer | viewer. Side-by-side while
          this container is wide enough for both; stacked, one pane at a time,
          when it is not — the container, not the viewport, because the panel
          is a 380px column on a wide screen. */}
      <div
        ref={panesRef}
        data-phone-view={phoneView}
        data-panes={panesWide ? "split" : "stacked"}
        className={`flex-1 min-h-0 flex ${panesWide ? "flex-row" : "flex-col"}`}
      >
        <aside
          ref={asideRef}
          className={[
            // One pane at a time while stacked: the list gets the whole height
            // until a file is opened, then it steps aside.
            phoneView === "file" && !panesWide ? "hidden" : "flex",
            "flex-col min-h-0 border-[var(--kin-hairline)] bg-[var(--kin-fill)]",
            panesWide
              ? "h-auto max-h-none w-[var(--ws-sidebar)] border-b-0 shrink-0"
              : "h-full w-full border-b",
          ].join(" ")}
          style={
            {
              // Not a `--kin-*` token: this one is a per-element measurement the
              // user drags, set on the element itself. The token namespace is
              // only for values that come from `design/theme.css`.
              ["--ws-sidebar" as string]: `${sidebarWidth}px`,
            } as CSSProperties
          }
        >
          <div className="flex-none flex items-center gap-1 px-2 py-1.5 border-b border-[var(--kin-hairline)]">
            {/*
              The shared tab strip holds the two lenses and nothing else: an
              action inside it would be announced as a third tab that selects
              nothing. The finder is that action, so it sits beside the list.
            */}
            <Tabs
              items={[
                {
                  id: "changes",
                  label: hasChanges
                    ? tr("workspace.tabChangesCount", { count: summaryFiles.length })
                    : tr("workspace.tabChanges"),
                  disabled: !hasChanges,
                },
                { id: "files", label: tr("workspace.tabFiles") },
              ]}
              value={lens}
              onChange={(id) => {
                if (id === "changes" || id === "files") pickWorkspaceLens(taskId, viewKey, id);
              }}
              ariaLabel={tr("workspace.sidebarTabs")}
              className="flex-1"
            />
            {onFindFile && (
              <Button
                variant="quiet"
                onClick={onFindFile}
                title={tr("workspace.find.actionHint")}
                aria-label={tr("workspace.find.action")}
                className="flex-none h-11 w-11 items-center justify-center p-0 text-kin-muted sm:h-6 sm:w-6"
              >
                <IconSearch size={13} />
              </Button>
            )}
          </div>
          {/*
            The answer to "what did this round do?", before any scrolling: how
            much changed and how many files, then which changes are in front.
            It belongs to the changes lens — the tree has nothing to summarize.
          */}
          {lens === "changes" && hasChanges && (
            <div
              data-testid="workspace-turn-summary"
              className="flex-none flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1 border-b border-[var(--kin-hairline)] text-caption"
            >
              <span className="flex-none font-mono tabular-nums text-kin-text">
                {summaryStats.hasStats ? (
                  <DeltaInline
                    additions={summaryStats.additions}
                    deletions={summaryStats.deletions}
                  />
                ) : (
                  <span className="font-sans text-kin-muted">
                    {tr("workspace.changed.noLineDelta")}
                  </span>
                )}
              </span>
              <span className="flex-none text-kin-muted">
                {tr("chat.evidence.files", { count: summaryFiles.length })}
              </span>
              {scopeAvailable && (
                // Two scopes, one pressed: a switch, not a second strip. The
                // words are the tab's own (`workspace.tabChanges`, "changes")
                // and the round card's (`chat.evidence.title`, "what this round
                // changed"), so the control names exactly the two things it
                // switches between — and does not invent a second word for
                // "changes" on the same line.
                <span className="ml-auto flex flex-none items-center gap-0.5">
                  <Button
                    variant="quiet"
                    aria-pressed={!showingTurn}
                    onClick={() => setTurnOnly(false)}
                    className={[
                      "rounded-md px-2 py-0.5 text-caption",
                      showingTurn ? "" : "bg-kin-elevated shadow-e1",
                    ].join(" ")}
                  >
                    {tr("workspace.tabChanges")}
                  </Button>
                  <Button
                    variant="quiet"
                    aria-pressed={showingTurn}
                    onClick={() => setTurnOnly(true)}
                    // The round's files come from the file tools, which is the
                    // same source and the same caveat the round card states.
                    title={tr("chat.evidence.scope")}
                    className={[
                      "rounded-md px-2 py-0.5 text-caption",
                      showingTurn ? "bg-kin-elevated shadow-e1" : "",
                    ].join(" ")}
                  >
                    {tr("chat.evidence.title")}
                  </Button>
                </span>
              )}
            </div>
          )}
          {lens === "changes" &&
            !viewedWorkspaceId &&
            sourceChangesFor(sourceChanges, taskId)?.truncated === true && (
              // A list that stopped early has to say so: a machine caps how many
              // changes it will describe at once, and the rest of them are not
              // "no changes". It belongs to the changes tab, not to the panel:
              // the tree has its own answer and its own notice.
              <div className="flex-none px-3 py-1.5 text-caption text-kin-muted border-b border-[var(--kin-hairline)]">
                {tr("workspace.changed.truncated")}
              </div>
            )}
          <div className="flex-1 min-h-0">
            {lens === "changes" ? (
              <ChangedFilesList
                files={summaryFiles}
                selectedPath={selectedPath}
                onSelect={(path) => void loadFile(path)}
              />
            ) : (
              <FileTree
                taskId={taskId}
                selectedPath={selectedPath}
                openPath={openPath}
                openNonce={openNonce}
                onSelect={(path) => void loadFile(path)}
                view={workspaceView}
              />
            )}
          </div>
        </aside>

        {/* Horizontal resize handle — only while the two panes are side by side. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={tr("workspace.resizeSidebar")}
          aria-valuenow={sidebarWidth}
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          tabIndex={0}
          className={`${panesWide ? "block" : "hidden"} flex-none w-1.5 cursor-col-resize border-r border-[var(--kin-hairline)] hover:bg-[var(--kin-fill-strong)] active:bg-kin-blue/15 transition-colors`}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            dragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startWidth: sidebarWidthRef.current,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            updateSidebarWidth(drag.startWidth + (event.clientX - drag.startX));
          }}
          onPointerUp={(event) => {
            const drag = dragRef.current;
            if (!drag || drag.pointerId !== event.pointerId) return;
            dragRef.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            persistSidebarWidth(sidebarWidthRef.current);
          }}
          onPointerCancel={(event) => {
            dragRef.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            persistSidebarWidth(sidebarWidthRef.current);
          }}
          onKeyDown={(event) => {
            const step = event.shiftKey ? 32 : 12;
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              updateSidebarWidth(sidebarWidthRef.current - step, true);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              updateSidebarWidth(sidebarWidthRef.current + step, true);
            } else if (event.key === "Home") {
              event.preventDefault();
              updateSidebarWidth(MIN_SIDEBAR_WIDTH, true);
            } else if (event.key === "End") {
              event.preventDefault();
              updateSidebarWidth(MAX_SIDEBAR_WIDTH, true);
            }
          }}
          onDoubleClick={() => updateSidebarWidth(DEFAULT_SIDEBAR_WIDTH, true)}
        />

        <div
          data-pane="viewer"
          className={[
            panesWide || phoneView === "file" ? "flex" : "hidden",
            "flex-1 min-w-0 min-h-0 bg-[var(--kin-bg)] flex-col",
          ].join(" ")}
        >
          {selectedPath && preview === "image" && fileBytes ? (
            <ImagePreview
              key={`${selectedPath}:${previewNonce}`}
              name={selectedPath}
              previewURL={fileBytes.preview}
              downloadURL={fileBytes.download}
            />
          ) : selectedPath && preview === "binary" && fileBytes ? (
            <DownloadPreview
              key={`${selectedPath}:${previewNonce}`}
              name={selectedPath}
              downloadURL={fileBytes.download}
              message={tr("workspace.viewer.binaryHint")}
            />
          ) : selectedPath && preview === "table" && !tableAsCode ? (
            <DelimitedTablePane
              path={selectedPath}
              content={file?.content ?? null}
              loading={loading}
              error={error}
              truncated={file?.truncated ?? false}
              onShowCode={() => setTableAsCode(true)}
            />
          ) : selectedPath ? (
            <Suspense fallback={<ViewerLoading />}>
              <CodeViewer
                path={selectedPath}
                file={normalizeFileResponse(file)}
                loading={loading}
                error={error}
                diff={enrichedDiff}
                cwd={cwd}
                taskId={taskId}
                workspaceId={workspaceView.kind === "generation" ? workspaceView.workspaceId : null}
                editable={workspaceView.editable}
                onSaved={(updated) => setFile(updated)}
                reviewActions={workspaceView.editable && reviewActions && Boolean(selectedPath)}
                actionsBusy={actionsBusy}
                onKeep={() => {
                  if (!selectedPath) return;
                  setDismissedPaths((prev) => {
                    const next = new Set(prev);
                    next.add(selectedPath);
                    return next;
                  });
                }}
                onDiscard={() => {
                  if (!selectedPath) return;
                  setDismissedPaths((prev) => {
                    const next = new Set(prev);
                    next.add(selectedPath);
                    return next;
                  });
                }}
              />
            </Suspense>
          ) : (
            // Rendering the empty state here rather than inside CodeViewer keeps
            // the editor chunk off the wire for the common case of opening the
            // panel before picking a file — which is what the header's Files
            // button does.
            <div className="h-full flex items-center justify-center text-strong leading-5 text-kin-muted px-6 text-center">
              {tr("workspace.viewer.empty")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Shown while the editor chunk is still downloading. */
function ViewerLoading() {
  const t = useT();
  return (
    <div
      // The chunk fetch is a real wait, and it replaced a node Monaco used to
      // render immediately; without this a screen reader gets silence.
      role="status"
      className="flex flex-1 items-center justify-center gap-2 text-strong text-kin-muted"
    >
      <IconSpinner size={14} strokeWidth={2} />
      {t("workspace.viewer.loading")}
    </div>
  );
}

/** Normalize WorkspaceFileResponse to TaskWorkspaceFileResponse shape for CodeViewer. */
function normalizeFileResponse(
  f: TaskWorkspaceFileResponse | WorkspaceFileResponse | null,
): TaskWorkspaceFileResponse | null {
  if (!f) return null;
  // TaskWorkspaceFileResponse has root, path, size, truncated, content
  if ("root" in f) return f as TaskWorkspaceFileResponse;
  // WorkspaceFileResponse has workspace_id, generation, view, path, size, truncated, content
  const wf = f as WorkspaceFileResponse;
  return {
    root: "",
    path: wf.path,
    size: wf.size,
    truncated: wf.truncated ?? false,
    content: wf.content,
  };
}

/**
 * One path as the checkout names it, or null when it is outside it.
 *
 * Tools report absolute paths and git reports workspace-relative ones; the
 * panel holds both, so a scope compares them in the one form that is the same
 * file either way. Suffix matching is deliberately not used: "README.md" would
 * then also match "docs/README.md", which the round never touched.
 */
function workspacePathKey(cwd: string, path: string): string | null {
  const relative = toWorkspaceRelativePath(cwd, path);
  return relative && relative !== "." ? relative : null;
}

/**
 * The paths the current round touched, or null when the stream carries no turn
 * boundary to scope to.
 *
 * A round begins at the user message that asked for it. On an isolated worktree
 * the daemon checkpoints at that same seq, and the record it writes names it as
 * `to_seq` — but only for the round *before* the one now running, and only on a
 * worktree task at all. So the boundary is whichever is newest: a user message
 * of the round in front, or a record's `to_seq` (a shared checkout writes no
 * record, and a worktree's first round has none yet). The round's own changes
 * are then what the file tools reported after that seq; the record's file list
 * is not read, because it describes the previous round — which is also why its
 * 200-file cap cannot make this scope under-report.
 */
function currentRoundPaths(events: TaskEvent[] | undefined): string[] | null {
  if (!events || events.length === 0) return null;
  let boundary: number | null = null;
  const consider = (seq: number) => {
    if (boundary === null || seq > boundary) boundary = seq;
  };
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === "message" && (payload.speaker === "user" || payload.role === "user")) {
      consider(event.seq);
      continue;
    }
    const toSeq = payload.to_seq;
    if (event.type === "round_changed" && typeof toSeq === "number") consider(toSeq);
  }
  if (boundary === null) return null;
  const afterSeq = boundary;
  const files = extractChangedFiles(events.filter((event) => event.seq > afterSeq));
  return files.length > 0 ? files.map((file) => file.path) : null;
}
