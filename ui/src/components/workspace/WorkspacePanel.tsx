import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  readTaskWorkspaceFile,
  type TaskWorkspaceFileResponse,
} from "../../api/client";
import { t } from "../../i18n";
import { useT } from "../../i18n/react";
import { projectLabel, shortPath } from "../../lib/paths";
import { IconPanel, IconX } from "../icons";
import CodeViewer from "./CodeViewer";
import FileTree from "./FileTree";

type Props = {
  taskId: string;
  cwd: string;
  openPath?: string | null;
  /** Bumps each time the user re-opens a path (even the same one). */
  openNonce?: number;
  onClose?: () => void;
};

export default function WorkspacePanel({ taskId, cwd, openPath, openNonce, onClose }: Props) {
  useT();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<TaskWorkspaceFileResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

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
  }, [cwd, taskId]);

  useEffect(() => {
    if (!openPath) return;
    void loadFile(openPath);
  }, [loadFile, openPath, openNonce]);

  return (
    <div className="h-full w-full min-w-0 min-h-0 flex flex-col kin-surface-inspector">
      <div className="flex-none flex items-center gap-2 border-b border-[var(--kin-hairline)] px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-kin-text">
            <IconPanel size={14} className="text-kin-blue flex-none" />
            <span>{t("workspace.title")}</span>
          </div>
          <div className="mt-0.5 text-[11.5px] text-kin-muted" title={cwd}>
            {projectLabel(cwd)} · {shortPath(cwd, 56)}
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="kin-btn-secondary min-h-0 px-2.5 py-1.5"
            aria-label={t("workspace.close")}
          >
            <IconX size={14} />
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 flex flex-col md:flex-row">
        <div className="h-[40%] min-h-[180px] max-h-[45%] flex-none border-b border-[var(--kin-hairline)] md:h-auto md:min-h-0 md:max-h-none md:w-[38%] md:max-w-[420px] md:border-b-0 md:border-r">
          <FileTree
            taskId={taskId}
            selectedPath={selectedPath}
            openPath={openPath}
            openNonce={openNonce}
            onSelect={(path) => void loadFile(path)}
          />
        </div>
        <div className="flex-1 min-w-0 min-h-0 bg-[#111214]">
          <CodeViewer
            path={selectedPath}
            file={file}
            loading={loading}
            error={error}
          />
        </div>
      </div>
    </div>
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
