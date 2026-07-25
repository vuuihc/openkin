import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Editor, { DiffEditor, type Monaco } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import {
  formatBytes,
  writeTaskWorkspaceFile,
  type TaskWorkspaceFileResponse,
} from "../../api/client";
import { useT } from "../../i18n/react";
import type { FileDiffSnippet } from "../../lib/changedFiles";
import Markdown from "../Markdown";
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
  /** Task id — required to persist edits. */
  taskId?: string;
  /** Allow editing + saving the open file (plain view only, never diff). */
  editable?: boolean;
  /** Called with the server response after a successful save. */
  onSaved?: (updated: TaskWorkspaceFileResponse) => void;
};

type MdViewMode = "preview" | "code";
type DiffLayout = "inline" | "sideBySide";

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

const MD_EXT_RE = /\.(md|mdx|markdown|mkd|mkdn|mdown)$/i;

function isMarkdownPath(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  return MD_EXT_RE.test(filePath);
}

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
  taskId,
  editable = false,
  onSaved,
}: Props) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [saveError, setSaveError] = useState<string | null>(null);
  // Markdown files default to rendered preview; user can switch to source.
  const [mdView, setMdView] = useState<MdViewMode>("preview");
  // Diff defaults to same-file (inline) layout.
  const [diffLayout, setDiffLayout] = useState<DiffLayout>("inline");
  const serverContent = file?.content ?? "";
  const saveRef = useRef<(() => void) | null>(null);
  const diffEditorRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);

  // Reset draft + view modes when the open path changes.
  useEffect(() => {
    setDraft(serverContent);
    setSaveState("idle");
    setSaveError(null);
    setMdView("preview");
    setDiffLayout("inline");
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps -- only on path change

  // Keep draft in sync when server content refreshes for the same path
  // (e.g. after agent write) and the user has not started editing.
  useEffect(() => {
    if (saveState === "idle" || saveState === "saved") {
      setDraft(serverContent);
      if (saveState === "saved") setSaveState("idle");
    }
  }, [serverContent]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drop the ref when the path changes so stale goToDiff calls never target a disposed instance.
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

  const dirty = draft !== serverContent;

  const doSave = useCallback(async () => {
    if (!taskId || !path || saveState === "saving") return;
    setSaveState("saving");
    setSaveError(null);
    try {
      const updated = await writeTaskWorkspaceFile(taskId, path, draft);
      setSaveState("saved");
      onSaved?.(updated);
    } catch (err) {
      setSaveState("error");
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [taskId, path, draft, saveState, onSaved]);

  // Keep the ⌘S/Ctrl+S command pointed at the latest save closure without
  // re-registering it on every keystroke.
  saveRef.current = doSave;

  const onEditorMount = useCallback((editor: unknown, monaco: Monaco) => {
    const ed = editor as MonacoEditor.IStandaloneCodeEditor;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveRef.current?.();
    });
  }, []);

  const diffOptions = useMemo(
    () => ({
      ...EDITOR_OPTIONS,
      renderSideBySide: diffLayout === "sideBySide",
      originalEditable: false,
      readOnly: true,
      renderIndicators: true,
      ignoreTrimWhitespace: false,
    }),
    [diffLayout],
  );

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
  const isMd = isMarkdownPath(path);
  // Markdown preview is only available in plain (non-diff) view.
  const showMdPreview = isMd && !useDiff && mdView === "preview" && Boolean(file);
  // Editing is only offered in the plain file view. Diffs stay read-only, and a
  // truncated file must not be saved or we would clobber the unseen tail.
  // Markdown preview mode is also non-editable (switch to Code to edit).
  const canEdit = Boolean(
    editable &&
      taskId &&
      file &&
      !useDiff &&
      !file.truncated &&
      !(isMd && mdView === "preview"),
  );
  // Keep the last good file mounted while a new path loads so Monaco is not
  // disposed/recreated on every navigation. Only blank the editor on hard error
  // with no content, or first open before any content arrives.
  const showEditor = (Boolean(file) || useDiff) && (!error || loading);
  const showError = Boolean(error) && !loading;
  const showInitialLoading = loading && !file && !useDiff;
  const openRoot = file?.root || cwd || "";
  const modifiedContent =
    file?.content != null && file.content.length > 0
      ? file.content
      : diff?.modified ?? "";

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
              aria-label={t("workspace.viewer.diffLayout")}
            >
              <button
                type="button"
                onClick={() => setDiffLayout("inline")}
                aria-pressed={diffLayout === "inline"}
                title={t("workspace.viewer.diffInline")}
                className={[
                  "px-1.5 py-0.5 rounded text-[10.5px] font-semibold transition-colors",
                  diffLayout === "inline"
                    ? "bg-kin-blue/20 text-kin-blue"
                    : "text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)]",
                ].join(" ")}
              >
                {t("workspace.viewer.diffInline")}
              </button>
              <button
                type="button"
                onClick={() => setDiffLayout("sideBySide")}
                aria-pressed={diffLayout === "sideBySide"}
                title={t("workspace.viewer.diffSideBySide")}
                className={[
                  "px-1.5 py-0.5 rounded text-[10.5px] font-semibold transition-colors",
                  diffLayout === "sideBySide"
                    ? "bg-kin-blue/20 text-kin-blue"
                    : "text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)]",
                ].join(" ")}
              >
                {t("workspace.viewer.diffSideBySide")}
              </button>
            </div>
          )}
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
          {isMd && !useDiff && file && (
            <div
              className="flex items-center gap-0.5 rounded-md border border-[var(--kin-hairline)] bg-[var(--kin-fill)]/50 p-0.5"
              role="group"
              aria-label={t("workspace.viewer.mdView")}
            >
              <button
                type="button"
                onClick={() => setMdView("preview")}
                aria-pressed={mdView === "preview"}
                title={t("workspace.viewer.preview")}
                className={[
                  "px-1.5 py-0.5 rounded text-[10.5px] font-semibold transition-colors",
                  mdView === "preview"
                    ? "bg-kin-blue/20 text-kin-blue"
                    : "text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)]",
                ].join(" ")}
              >
                {t("workspace.viewer.preview")}
              </button>
              <button
                type="button"
                onClick={() => setMdView("code")}
                aria-pressed={mdView === "code"}
                title={t("workspace.viewer.code")}
                className={[
                  "px-1.5 py-0.5 rounded text-[10.5px] font-semibold transition-colors",
                  mdView === "code"
                    ? "bg-kin-blue/20 text-kin-blue"
                    : "text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)]",
                ].join(" ")}
              >
                {t("workspace.viewer.code")}
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
          {editable && file?.truncated && !useDiff && (
            <span
              className="flex-none rounded bg-kin-orange/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-kin-orange"
              title={t("workspace.viewer.readOnlyTruncated")}
            >
              {t("workspace.viewer.readOnlyTruncated")}
            </span>
          )}
          {canEdit && (
            <>
              {saveState === "error" && saveError && (
                <span className="text-kin-red" title={saveError}>
                  {t("workspace.viewer.saveFailed")}
                </span>
              )}
              {saveState === "saved" && !dirty && (
                <span className="text-kin-green">
                  {t("workspace.viewer.saved")}
                </span>
              )}
              <button
                type="button"
                disabled={!dirty || saveState === "saving"}
                onClick={() => void doSave()}
                title={t("workspace.viewer.save")}
                className="kin-btn-primary !min-h-0 !py-1 !px-2 text-[11px] disabled:opacity-50"
              >
                <IconCheck size={12} />
                {saveState === "saving"
                  ? t("workspace.viewer.saving")
                  : t("workspace.viewer.save")}
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
              key={`diff-${diffLayout}-${path}`}
              height="100%"
              theme="vs-dark"
              language={languageForPath(path)}
              original={diff.original}
              modified={modifiedContent}
              options={diffOptions}
              onMount={onDiffMount}
              loading={
                <div className="h-full flex items-center justify-center text-sm text-kin-muted">
                  {t("workspace.viewer.loading")}
                </div>
              }
            />
          </MonacoSafe>
        )}
        {showEditor && !useDiff && file && showMdPreview && (
          <div className="h-full overflow-auto kin-scroll px-5 py-4">
            {/* Prefer draft so unsaved Code-mode edits still preview correctly. */}
            <Markdown text={draft || file.content} />
          </div>
        )}
        {showEditor && !useDiff && file && !showMdPreview && (
          <MonacoSafe fallback={<FallbackPre text={file.content} />}>
            <Editor
              height="100%"
              theme="vs-dark"
              language={languageForPath(path)}
              value={canEdit ? draft : file.content}
              onChange={
                canEdit ? (next) => setDraft(next ?? "") : undefined
              }
              onMount={canEdit ? onEditorMount : undefined}
              options={
                canEdit ? { ...EDITOR_OPTIONS, readOnly: false } : EDITOR_OPTIONS
              }
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
  if (name.endsWith(".md") || name.endsWith(".mdx") || name.endsWith(".markdown")) {
    return "markdown";
  }
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
