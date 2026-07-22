import {
  Component,
  useCallback,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import Editor, { DiffEditor } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import {
  formatBytes,
  type TaskWorkspaceFileResponse,
} from "../../api/client";
import { useT } from "../../i18n/react";
import type { FileDiffSnippet } from "../../lib/changedFiles";
import { IconCheck, IconChevron, IconX } from "../icons";
import OpenInMenu from "./OpenInMenu";
import "./monacoSetup";

type Props = {
  path: string | null;
  file: TaskWorkspaceFileResponse | null;
  loading: boolean;
  error: string | null;
  /** When set, render a Monaco DiffEditor (original vs modified). */
  diff?: FileDiffSnippet | null;
  /** Task workspace root — used to resolve absolute path for "Open in…". */
  cwd?: string;
  /** Show keep/discard controls for the open file. */
  reviewActions?: boolean;
  onKeep?: () => void;
  onDiscard?: () => void;
  actionsBusy?: boolean;
};

const EDITOR_OPTIONS = {
  readOnly: true,
  minimap: { enabled: false },
  fontSize: 13,
  wordWrap: "on" as const,
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderLineHighlight: "none" as const,
  padding: { top: 12, bottom: 12 },
  scrollbar: {
    verticalScrollbarSize: 10,
    horizontalScrollbarSize: 10,
  },
};

const DIFF_OPTIONS = {
  ...EDITOR_OPTIONS,
  renderSideBySide: true,
  originalEditable: false,
  readOnly: true,
  renderIndicators: true,
  ignoreTrimWhitespace: false,
};

export default function CodeViewer({
  path,
  file,
  loading,
  error,
  diff,
  cwd,
  reviewActions = false,
  onKeep,
  onDiscard,
  actionsBusy = false,
}: Props) {
  const t = useT();
  const diffEditorRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(
    null,
  );

  // Drop the editor handle when leaving diff mode / switching path so
  // stale goToDiff calls never target a disposed instance.
  useEffect(() => {
    return () => {
      diffEditorRef.current = null;
    };
  }, [path]);

  const onDiffMount = useCallback(
    (editor: MonacoEditor.IStandaloneDiffEditor) => {
      diffEditorRef.current = editor;
    },
    [],
  );

  const goToHunk = useCallback((target: "next" | "previous") => {
    const ed = diffEditorRef.current;
    if (!ed) return;
    try {
      ed.goToDiff(target);
    } catch {
      // Editor may be mid-dispose during path switches.
    }
  }, []);

  if (!path) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-kin-muted px-6 text-center">
        {t("workspace.viewer.empty")}
      </div>
    );
  }

  // Prefer tool-derived diff when available; fall back to plain file view.
  const useDiff = Boolean(
    diff && (diff.original.length > 0 || diff.modified.length > 0),
  );
  // Keep the last good file mounted while a new path loads so Monaco is not
  // disposed/recreated on every navigation. Only blank the editor on hard error
  // with no content, or first open before any content arrives.
  const showEditor = (Boolean(file) || useDiff) && (!error || loading);
  const showError = Boolean(error) && !loading;
  const showInitialLoading = loading && !file && !useDiff;
  const openRoot = file?.root || cwd || "";

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex-none flex items-center gap-2 border-b border-[var(--kin-hairline)] px-3 py-2 text-[11.5px] text-kin-muted">
        <span
          className="font-mono text-kin-secondary truncate min-w-0"
          title={path}
        >
          {path}
        </span>
        {useDiff && (
          <span className="flex-none rounded bg-kin-blue/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-kin-blue">
            {t("workspace.viewer.diff")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {useDiff && (
            <div
              className="flex items-center gap-0.5 rounded-md border border-[var(--kin-hairline)] bg-[var(--kin-fill)]/50 p-0.5"
              role="group"
              aria-label={t("workspace.viewer.diffNav")}
            >
              <button
                type="button"
                onClick={() => goToHunk("previous")}
                title={t("workspace.viewer.prevHunk")}
                aria-label={t("workspace.viewer.prevHunk")}
                className="p-1 rounded text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-kin-blue"
              >
                {/* Chevron points right by default; rotate for up/down. */}
                <IconChevron size={13} className="-rotate-90" />
              </button>
              <button
                type="button"
                onClick={() => goToHunk("next")}
                title={t("workspace.viewer.nextHunk")}
                aria-label={t("workspace.viewer.nextHunk")}
                className="p-1 rounded text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-kin-blue"
              >
                <IconChevron size={13} className="rotate-90" />
              </button>
            </div>
          )}
          {file && (
            <span className="tabular-nums">
              {formatBytes(file.size)}
              {file.truncated ? ` · ${t("workspace.viewer.truncated")}` : ""}
              {loading ? " · …" : ""}
            </span>
          )}
          {!file && loading && <span className="tabular-nums">…</span>}
          {reviewActions && path && (
            <>
              <button
                type="button"
                disabled={actionsBusy}
                onClick={() => onDiscard?.()}
                title={t("workspace.changed.discardHint")}
                className="kin-btn-secondary !min-h-0 !py-1 !px-2 text-[11px] disabled:opacity-50"
              >
                <IconX size={12} />
                {t("workspace.changed.discard")}
              </button>
              <button
                type="button"
                disabled={actionsBusy}
                onClick={() => onKeep?.()}
                title={t("workspace.changed.keepHint")}
                className="kin-btn-primary !min-h-0 !py-1 !px-2 text-[11px] disabled:opacity-50"
              >
                <IconCheck size={12} />
                {t("workspace.changed.keep")}
              </button>
            </>
          )}
          <OpenInMenu root={openRoot} relativePath={path} />
        </div>
      </div>

      <div className="flex-1 min-h-0 relative">
        {showInitialLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-kin-muted bg-[#111214]/80">
            {t("workspace.viewer.loading")}
          </div>
        )}
        {showError && !showEditor && (
          <div className="h-full flex items-center justify-center text-sm text-kin-red px-6 text-center">
            {error}
          </div>
        )}
        {showError && showEditor && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 rounded-md bg-kin-red/90 px-3 py-1 text-[12px] text-white shadow">
            {error}
          </div>
        )}
        {showEditor && useDiff && diff && (
          <MonacoSafe
            fallback={<FallbackPre text={diff.modified || diff.original} />}
          >
            <DiffEditor
              height="100%"
              theme="vs-dark"
              language={languageForPath(path)}
              original={diff.original}
              modified={
                // Prefer live file content as the modified side when we have it
                // (write tools often only store the new body in the event).
                file?.content != null && file.content.length > 0
                  ? file.content
                  : diff.modified
              }
              options={DIFF_OPTIONS}
              onMount={onDiffMount}
              loading={
                <div className="h-full flex items-center justify-center text-sm text-kin-muted">
                  {t("workspace.viewer.loading")}
                </div>
              }
            />
          </MonacoSafe>
        )}
        {showEditor && !useDiff && file && (
          <MonacoSafe fallback={<FallbackPre text={file.content} />}>
            <Editor
              height="100%"
              theme="vs-dark"
              language={languageForPath(path)}
              value={file.content}
              options={EDITOR_OPTIONS}
              loading={
                <div className="h-full flex items-center justify-center text-sm text-kin-muted">
                  {t("workspace.viewer.loading")}
                </div>
              }
            />
          </MonacoSafe>
        )}
      </div>
    </div>
  );
}

function FallbackPre({ text }: { text: string }) {
  return (
    <pre className="h-full overflow-auto kin-scroll p-4 text-[12px] font-mono text-kin-secondary whitespace-pre">
      {text}
    </pre>
  );
}

class MonacoSafe extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

function languageForPath(filePath: string): string {
  const name = filePath.toLowerCase();
  if (name.endsWith(".tsx")) return "typescript";
  if (name.endsWith(".ts")) return "typescript";
  if (name.endsWith(".jsx")) return "javascript";
  if (name.endsWith(".js") || name.endsWith(".mjs") || name.endsWith(".cjs")) {
    return "javascript";
  }
  if (name.endsWith(".go")) return "go";
  if (name.endsWith(".rs")) return "rust";
  if (name.endsWith(".py")) return "python";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".md")) return "markdown";
  if (name.endsWith(".css")) return "css";
  if (name.endsWith(".html")) return "html";
  if (name.endsWith(".xml")) return "xml";
  if (name.endsWith(".java")) return "java";
  if (name.endsWith(".kt")) return "kotlin";
  if (name.endsWith(".sh") || name.endsWith(".bash") || name.endsWith(".zsh")) {
    return "shell";
  }
  if (name.endsWith(".yml") || name.endsWith(".yaml")) return "yaml";
  if (name.endsWith(".sql")) return "sql";
  if (name.endsWith(".toml")) return "toml";
  if (name.endsWith(".ini")) return "ini";
  if (name.endsWith(".txt")) return "plaintext";
  return "plaintext";
}
