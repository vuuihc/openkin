import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, listTaskWorkspace, type TaskWorkspaceEntry } from "../../api/client";
import { t } from "../../i18n";
import { useT } from "../../i18n/react";
import { normalizeRelativePath } from "../../lib/paths";
import { IconChevron, IconFile, IconFolder } from "../icons";

type Props = {
  taskId: string;
  selectedPath: string | null;
  openPath?: string | null;
  /** Bumps each time the user re-opens a path, forcing re-expansion. */
  openNonce?: number;
  onSelect: (path: string) => void;
};

type DirState = {
  entries: TaskWorkspaceEntry[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  truncated: boolean;
};

const ROOT = ".";

export default function FileTree({ taskId, selectedPath, openPath, openNonce, onSelect }: Props) {
  useT();
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ [ROOT]: true });
  const loadingRef = useRef<Set<string>>(new Set());

  const loadDir = useCallback(async (dirPath: string) => {
    if (loadingRef.current.has(dirPath)) return;
    loadingRef.current.add(dirPath);
    setDirs((prev) => ({
      ...prev,
      [dirPath]: {
        entries: prev[dirPath]?.entries ?? [],
        loading: true,
        loaded: prev[dirPath]?.loaded ?? false,
        error: null,
        truncated: prev[dirPath]?.truncated ?? false,
      },
    }));
    try {
      const res = await listTaskWorkspace(taskId, dirPath === ROOT ? undefined : dirPath);
      setDirs((prev) => ({
        ...prev,
        [dirPath]: {
          entries: res.entries,
          loading: false,
          loaded: true,
          error: null,
          truncated: Boolean(res.truncated),
        },
      }));
    } catch (error) {
      setDirs((prev) => ({
        ...prev,
        [dirPath]: {
          entries: prev[dirPath]?.entries ?? [],
          loading: false,
          loaded: false,
          error: workspaceErrorMessage(error),
          truncated: false,
        },
      }));
    } finally {
      loadingRef.current.delete(dirPath);
    }
  }, [taskId]);

  useEffect(() => {
    loadingRef.current.clear();
    setDirs({});
    setExpanded({ [ROOT]: true });
    void loadDir(ROOT);
  }, [loadDir, taskId]);

  const expandToPath = useCallback(async (targetPath: string) => {
    const clean = normalizeRelativePath(targetPath);
    if (!clean || clean === ROOT) return;
    const segments = clean.split("/");
    let dir = ROOT;
    for (const segment of segments.slice(0, -1)) {
      dir = dir === ROOT ? segment : `${dir}/${segment}`;
      setExpanded((prev) => ({ ...prev, [dir]: true }));
      await loadDir(dir);
    }
  }, [loadDir]);

  useEffect(() => {
    if (!openPath) return;
    void expandToPath(openPath);
  }, [expandToPath, openPath, openNonce]);

  const rootState = dirs[ROOT];
  const rootEntries = useMemo(() => rootState?.entries ?? [], [rootState?.entries]);

  return (
    <div className="h-full min-h-0 overflow-auto kin-scroll px-2 py-2">
      {rootState?.loading && rootEntries.length === 0 && (
        <div className="px-2 py-1.5 text-[12px] text-kin-muted">{t("workspace.tree.loading")}</div>
      )}
      {rootState?.error && (
        <div className="mx-2 my-1 rounded-lg border border-[rgba(255,69,58,.25)] bg-[rgba(255,69,58,.08)] px-2.5 py-2 text-[12px] text-[#ffb4ad]">
          {rootState.error}
        </div>
      )}
      {renderEntries({
        entries: rootEntries,
        depth: 0,
        dirs,
        expanded,
        selectedPath,
        onSelect,
        onToggle: async (entry) => {
          const next = !expanded[entry.path];
          setExpanded((prev) => ({ ...prev, [entry.path]: next }));
          if (next && !dirs[entry.path]?.loaded) {
            await loadDir(entry.path);
          }
        },
      })}
      {rootState?.truncated && (
        <div className="px-2 py-2 text-[11px] text-kin-muted">
          {t("workspace.tree.truncatedRoot")}
        </div>
      )}
    </div>
  );
}

function renderEntries({
  entries,
  depth,
  dirs,
  expanded,
  selectedPath,
  onSelect,
  onToggle,
}: {
  entries: TaskWorkspaceEntry[];
  depth: number;
  dirs: Record<string, DirState>;
  expanded: Record<string, boolean>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
  onToggle: (entry: TaskWorkspaceEntry) => Promise<void>;
}) {
  return entries.map((entry) => {
    const isDir = entry.type === "dir";
    const isExpanded = Boolean(expanded[entry.path]);
    const dirState = dirs[entry.path];
    const isSelected = selectedPath === entry.path;

    return (
      <div key={entry.path}>
        <button
          type="button"
          onClick={() => {
            if (isDir) {
              void onToggle(entry);
            } else {
              onSelect(entry.path);
            }
          }}
          className={[
            "w-full flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[12.5px] transition-colors",
            isSelected
              ? "bg-kin-blue/20 text-white"
              : "text-kin-secondary hover:bg-[var(--kin-fill)] hover:text-kin-text",
          ].join(" ")}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={entry.path}
        >
          {isDir ? (
            <IconChevron
              size={13}
              className={[
                "flex-none text-kin-muted transition-transform",
                isExpanded ? "rotate-90" : "",
              ].join(" ")}
            />
          ) : (
            <span className="w-[13px] flex-none" />
          )}
          {isDir ? (
            <IconFolder size={14} className="flex-none text-kin-secondary" />
          ) : (
            <IconFile size={13} className="flex-none text-kin-muted" />
          )}
          <span className="truncate">{entry.name}</span>
        </button>

        {isDir && isExpanded && (
          <div>
            {dirState?.loading && (
              <div
                className="px-2 py-1 text-[11px] text-kin-muted"
                style={{ paddingLeft: 36 + depth * 14 }}
              >
                {t("workspace.tree.loadingMore")}
              </div>
            )}
            {dirState?.error && (
              <div
                className="px-2 py-1 text-[11px] text-[#ffb4ad]"
                style={{ paddingLeft: 36 + depth * 14 }}
              >
                {dirState.error}
              </div>
            )}
            {dirState?.entries &&
              renderEntries({
                entries: dirState.entries,
                depth: depth + 1,
                dirs,
                expanded,
                selectedPath,
                onSelect,
                onToggle,
              })}
            {dirState?.truncated && (
              <div
                className="px-2 py-1 text-[11px] text-kin-muted"
                style={{ paddingLeft: 36 + depth * 14 }}
              >
                {t("workspace.tree.truncated")}
              </div>
            )}
          </div>
        )}
      </div>
    );
  });
}

function workspaceErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return unwrapApiErrorMessage(error.message);
  }
  return error instanceof Error ? error.message : t("workspace.tree.loadFailed");
}

function unwrapApiErrorMessage(message: string): string {
  try {
    const parsed = JSON.parse(message) as { error?: unknown };
    if (typeof parsed.error === "string" && parsed.error) {
      return parsed.error;
    }
  } catch {
    // ignore
  }
  return message;
}
