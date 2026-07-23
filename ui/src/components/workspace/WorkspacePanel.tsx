import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  ApiError,
  readTaskWorkspaceFile,
  type TaskEvent,
  type TaskWorkspaceFileResponse,
} from "../../api/client";
import { t } from "../../i18n";
import { useT } from "../../i18n/react";
import {
  extractChangedFiles,
  extractFileDiff,
  type ChangedFile,
  type FileDiffSnippet,
} from "../../lib/changedFiles";
import { projectLabel, shortPath } from "../../lib/paths";
import { IconPanel, IconX } from "../icons";
import ChangedFilesList from "./ChangedFilesList";
import CodeViewer from "./CodeViewer";
import FileTree from "./FileTree";

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

type DragState = {
  pointerId: number;
  startX: number;
  startWidth: number;
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
  reviewActions = false,
  onDiscardAll,
  actionsBusy = false,
}: Props) {
  useT();
  const tr = useT();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<TaskWorkspaceFileResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedPaths, setDismissedPaths] = useState<Set<string>>(() => new Set());
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

  const changedFiles = useMemo(() => {
    if (changedFilesProp) return changedFilesProp;
    if (!events || events.length === 0) return [] as ChangedFile[];
    return extractChangedFiles(events);
  }, [changedFilesProp, events]);

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
      const next = await readTaskWorkspaceFile(taskId, path);
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
  }, [taskId]);

  useEffect(() => {
    requestRef.current += 1;
    setSelectedPath(null);
    setFile(null);
    setLoading(false);
    setError(null);
    userPickedTab.current = false;
  }, [cwd, taskId]);

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
          <div className="text-[12px] font-semibold text-kin-text truncate">
            {tr("workspace.title")}
          </div>
          <div className="text-[11px] text-kin-muted font-mono truncate" title={cwd}>
            {projectLabel(cwd)} · {shortPath(cwd, 48)}
          </div>
        </div>
        {reviewActions && onDiscardAll && (
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

        <div className="flex-1 min-w-0 min-h-0 bg-[#111214] flex flex-col">
          <CodeViewer
            path={selectedPath}
            file={file}
            loading={loading}
            error={error}
            diff={enrichedDiff}
            cwd={cwd}
            taskId={taskId}
            editable
            onSaved={(updated) => setFile(updated)}
            reviewActions={reviewActions && Boolean(selectedPath)}
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
        </div>
      </div>
    </div>
  );
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
