import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ApiError,
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
  type ChangedFile,
  type FileDiffSnippet,
} from "../../lib/changedFiles";
import WorkspaceGenerationPicker from "./WorkspaceGenerationPicker";
import { projectLabel, shortPath } from "../../lib/paths";
import { IconPanel, IconSpinner, IconX } from "../icons";
import ChangedFilesList from "./ChangedFilesList";
import FileTree from "./FileTree";

import {
  effectiveCurrentWorkspaceID,
  readWorkspaceViewFile,
  resolveWorkspaceView,
  workspaceLifecycleRefreshKey,
} from "./workspaceView";

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
};

type SidebarTab = "changes" | "files";

const SIDEBAR_WIDTH_KEY = "kin.workspace.sidebarWidth";
const DEFAULT_SIDEBAR_WIDTH = 320;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 560;
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
}: Props) {
  useT();
  const tr = useT();
  const generationRefreshKey = workspaceLifecycleRefreshKey(
    events,
    currentWorkspaceId,
  );
  const [generationResource, setGenerationResource] =
    useState<WorkspaceGenerationResource>(() => ({
      taskId,
      refreshKey: generationRefreshKey,
      generations: [],
      loading: true,
    }));
  const generationResourceCurrent =
    generationResource.taskId === taskId &&
    generationResource.refreshKey === generationRefreshKey;
  const generations = generationResourceCurrent
    ? generationResource.generations
    : [];
  const generationsLoading =
    !generationResourceCurrent || generationResource.loading;
  const effectiveCurrentWorkspaceId = effectiveCurrentWorkspaceID(
    currentWorkspaceId,
    generations,
  );

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
    () =>
      resolveWorkspaceView(
        selectedWorkspaceId,
        effectiveCurrentWorkspaceId,
        generations,
      ),
    [selectedWorkspaceId, effectiveCurrentWorkspaceId, generations],
  );
  const viewedWorkspaceId =
    workspaceView.kind === "generation" ? workspaceView.workspaceId : null;
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<TaskWorkspaceFileResponse | WorkspaceFileResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedPaths, setDismissedPaths] = useState<Set<string>>(() => new Set());
  const [genDiffFiles, setGenDiffFiles] = useState<ChangedFile[]>([]);
  const [genDiffLoaded, setGenDiffLoaded] = useState(false);
  const [sourceChanges, setSourceChanges] = useState<{
    taskId: string;
    files: ChangedFile[];
    truncated: boolean;
  } | null>(null);
  const requestRef = useRef(0);

  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth);
  const sidebarWidthRef = useRef(sidebarWidth);
  const dragRef = useRef<DragState | null>(null);
  const panesRef = useRef<HTMLDivElement>(null);

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
    if (!viewedWorkspaceId && sourceChanges?.taskId === taskId) {
      return sourceChanges.files;
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
        (f) =>
          f.action !== "read" &&
          f.action !== "other" &&
          !dismissedPaths.has(f.path),
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
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(
    hasChanges ? "changes" : "files",
  );

  // Prefer Changes tab whenever the task gains mutations; don't yank the user
  // away if they already switched to Files manually after open.
  const userPickedTab = useRef(false);
  useEffect(() => {
    if (userPickedTab.current) return;
    setSidebarTab(hasChanges ? "changes" : "files");
  }, [hasChanges]);

  const loadFile = useCallback(async (path: string) => {
    const reqID = ++requestRef.current;
    setSelectedPath(path);
    setLoading(true);
    setError(null);
    try {
      const next = await readWorkspaceViewFile(workspaceView, taskId, path);
      if (requestRef.current !== reqID) return;
      setFile(next);
    } catch (err) {
      if (requestRef.current !== reqID) return;
      setFile(null);
      setError(workspaceErrorMessage(err));
    } finally {
      if (requestRef.current === reqID) {
        setLoading(false);
      }
    }
  }, [taskId, workspaceView]);

  useEffect(() => {
    requestRef.current += 1;
    setSelectedPath(null);
    setFile(null);
    setLoading(false);
    setError(null);
    setGenDiffFiles([]);
    setSourceChanges(null);
    userPickedTab.current = false;
  }, [cwd, taskId, workspaceView.kind, workspaceView.workspaceId]);

  useEffect(() => {
    if (!openPath) return;
    // Opening from the chat/changed bar: jump to Changes when possible.
    if (hasChanges && !userPickedTab.current) {
      setSidebarTab("changes");
    }
    void loadFile(openPath);
  }, [openPath, openNonce, loadFile, hasChanges]);

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

  const pickTab = (tab: SidebarTab) => {
    userPickedTab.current = true;
    setSidebarTab(tab);
  };

  return (
    <div className="h-full min-h-0 flex flex-col bg-[var(--kin-inspector)]">
      <div className="flex-none flex items-center gap-2 border-b border-[var(--kin-hairline)] px-3 py-2">
        <IconPanel size={14} className="text-kin-muted flex-none" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[12px] font-semibold text-kin-text truncate">
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
          <div className="text-[11px] text-kin-muted font-mono truncate" title={cwd}>
            {projectLabel(cwd)} · {shortPath(cwd, 48)}
          </div>
        </div>
        {workspaceView.editable && reviewActions && onDiscardAll && (
          <button
            type="button"
            disabled={actionsBusy || !hasChanges}
            onClick={() => void onDiscardAll()}
            title={tr("workspace.changed.discardAllHint")}
            className="kin-btn-secondary !min-h-0 !py-1 !px-2.5 text-[11.5px] disabled:opacity-50"
          >
            {tr("workspace.changed.discardAll")}
          </button>
        )}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="flex-none rounded-md p-1.5 text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill)]"
            aria-label={tr("workspace.close")}
          >
            <IconX size={14} />
          </button>
        )}
      </div>

      {/* Dual pane: sidebar (list/tree) | resizer | viewer. Always side-by-side on md+. */}
      <div ref={panesRef} className="flex-1 min-h-0 flex flex-col md:flex-row">
        <aside
          className="flex flex-col min-h-0 border-b border-[var(--kin-hairline)] h-[40%] max-h-[46%] w-full md:h-auto md:max-h-none md:w-[var(--kin-ws-sidebar)] md:border-b-0 md:shrink-0 bg-[var(--kin-fill)]/40"
          style={
            {
              ["--kin-ws-sidebar" as string]: `${sidebarWidth}px`,
            } as CSSProperties
          }
        >
          <div
            className="flex-none flex items-center gap-1 px-2 py-1.5 border-b border-[var(--kin-hairline)]"
            role="tablist"
            aria-label={tr("workspace.sidebarTabs")}
          >
            <TabButton
              active={sidebarTab === "changes"}
              disabled={!hasChanges}
              onClick={() => pickTab("changes")}
              label={
                hasChanges
                  ? tr("workspace.tabChangesCount", { count: visibleChangedFiles.length })
                  : tr("workspace.tabChanges")
              }
            />
            <TabButton
              active={sidebarTab === "files"}
              onClick={() => pickTab("files")}
              label={tr("workspace.tabFiles")}
            />
          </div>
          {sidebarTab === "changes" &&
            !viewedWorkspaceId &&
            sourceChanges?.truncated === true && (
              // A list that stopped early has to say so: a machine caps how many
              // changes it will describe at once, and the rest of them are not
              // "no changes". It belongs to the changes tab, not to the panel:
              // the tree has its own answer and its own notice.
              <div className="flex-none px-3 py-1.5 text-[11px] text-kin-muted border-b border-[var(--kin-hairline)]">
                {tr("workspace.changed.truncated")}
              </div>
            )}
          <div className="flex-1 min-h-0">
            {sidebarTab === "changes" ? (
              <ChangedFilesList
                files={visibleChangedFiles}
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

        {/* Horizontal resize handle — desktop md+ only. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={tr("workspace.resizeSidebar")}
          aria-valuenow={sidebarWidth}
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          tabIndex={0}
          className="hidden md:block flex-none w-1.5 cursor-col-resize border-r border-[var(--kin-hairline)] hover:bg-[var(--kin-fill-strong)] active:bg-kin-blue/30 transition-colors"
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

        <div className="flex-1 min-w-0 min-h-0 bg-[var(--kin-bg)] flex flex-col">
          {selectedPath ? (
            <Suspense fallback={<ViewerLoading />}>
              <CodeViewer
                path={selectedPath}
                file={normalizeFileResponse(file)}
                loading={loading}
                error={error}
                diff={enrichedDiff}
                cwd={cwd}
                taskId={taskId}
                workspaceId={
                  workspaceView.kind === "generation"
                    ? workspaceView.workspaceId
                    : null
                }
                editable={workspaceView.editable}
                onSaved={(updated) => setFile(updated)}
                reviewActions={
                  workspaceView.editable && reviewActions && Boolean(selectedPath)
                }
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
            <div className="h-full flex items-center justify-center text-sm text-kin-muted px-6 text-center">
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
      className="flex flex-1 items-center justify-center gap-2 text-[13px] text-kin-muted"
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

function TabButton({
  active,
  disabled,
  onClick,
  label,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      disabled={disabled}
      onClick={onClick}
      className={[
        "flex-1 min-w-0 truncate rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors",
        disabled ? "opacity-40 cursor-not-allowed" : "",
        active
          ? "bg-kin-elevated text-kin-text shadow-sm border border-[var(--kin-hairline)]"
          : "text-kin-muted hover:text-kin-secondary hover:bg-black/[.03] dark:hover:bg-white/[.04]",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function workspaceErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    try {
      const parsed = JSON.parse(error.message) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error) {
        return parsed.error;
      }
    } catch {
      // ignore
    }
    return error.message;
  }
  return error instanceof Error ? error.message : t("workspace.viewer.readFailed");
}
