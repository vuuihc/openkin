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
  writeWorkspaceFile,
  type TaskWorkspaceFileResponse,
  type WorkspaceFileResponse,
} from "../../api/client";
import { useT } from "../../i18n/react";
import { t as translate } from "../../i18n";
import type { FileDiffSnippet } from "../../lib/changedFiles";
import Markdown from "../Markdown";
import { IconCheck, IconChevron, IconX } from "../icons";
import Button from "../ui/Button";
import { anchorForLine, isChangedLine, type DiffAnchor } from "./diffCommentAnchor";
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
  /** Selected generation id for generation-aware writes. */
  workspaceId?: string | null;
  /** Allow editing + saving the open file (plain view only, never diff). */
  editable?: boolean;
  /** Called with the server response after a successful save. */
  onSaved?: (updated: TaskWorkspaceFileResponse | WorkspaceFileResponse) => void;
  /**
   * KIN-RESULT-003: called with the anchor of a changed diff line the person
   * wants to comment. Supplying it is what turns on the gutter affordance.
   */
  onCommentLine?: (anchor: DiffAnchor) => void;
  /**
   * Reveal, highlight and focus a modified line. The nonce makes the same line
   * requestable twice (jump, then back again after the box closes).
   */
  focusLine?: { line: number; nonce: number; path?: string } | null;
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
  workspaceId,
  editable = false,
  onSaved,
  onCommentLine,
  focusLine,
}: Props) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  // Markdown files default to rendered preview; user can switch to source.
  const [mdView, setMdView] = useState<MdViewMode>("preview");
  // Diff defaults to same-file (inline) layout.
  const [diffLayout, setDiffLayout] = useState<DiffLayout>("inline");
  const serverContent = file?.content ?? "";
  const saveRef = useRef<(() => void) | null>(null);
  const diffEditorRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
  // KIN-RESULT-003: the comment entry and the tray's jump share this editor
  // state. Line changes come from Monaco's own diff, never a second algorithm.
  const [diffLineChanges, setDiffLineChanges] = useState<MonacoEditor.ILineChange[] | null>(null);
  const [cursorLine, setCursorLine] = useState(1);
  const monacoRef = useRef<Monaco | null>(null);
  const glyphsRef = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  const flashRef = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);
  const flashTimerRef = useRef<number | null>(null);
  const pendingFocusRef = useRef<{ line: number; nonce: number } | null>(null);
  const appliedFocusNonceRef = useRef(0);
  // The editor is mounted asynchronously, and it remounts on every layout or
  // path change. These refs keep the latest closure reachable from the
  // instance that eventually mounts.
  const revealLineRef = useRef<(line: number) => boolean>(() => false);
  const requestCommentRef = useRef<(line: number) => void>(() => {});
  const onCommentLineRef = useRef(onCommentLine);
  onCommentLineRef.current = onCommentLine;

  // Reset draft + view modes when the open path changes.
  useEffect(() => {
    setDraft(serverContent);
    setSaveState("idle");
    setSaveError(null);
    setMdView("preview");
    setDiffLayout("inline");
    setDiffLineChanges(null);
    setCursorLine(1);
  }, [path]); // eslint-disable-line react-hooks/exhaustive-deps -- only on path change

  // Keep draft in sync when server content refreshes for the same path
  // (e.g. after agent write) and the user has not started editing.
  useEffect(() => {
    if (saveState === "idle" || saveState === "saved") {
      setDraft(serverContent);
      if (saveState === "saved") setSaveState("idle");
    }
  }, [serverContent]); // eslint-disable-line react-hooks/exhaustive-deps -- reading `saveState` is the point: depending on it would re-sync the draft every time the save state moves, which is while the user is typing

  // Drop the ref when the path changes so stale goToDiff calls never target a disposed instance.
  useEffect(() => {
    return () => {
      diffEditorRef.current = null;
      monacoRef.current = null;
      glyphsRef.current = null;
      flashRef.current?.clear();
      flashRef.current = null;
      if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    };
  }, [path]);

  /** Reveal a modified line, flash it, and put keyboard focus there. */
  const revealLine = useCallback((line: number): boolean => {
    const editor = diffEditorRef.current;
    const monaco = monacoRef.current;
    const modified = editor?.getModifiedEditor();
    const model = modified?.getModel();
    if (!editor || !monaco || !modified || !model || line < 1 || line > model.getLineCount()) {
      return false;
    }
    modified.revealLineInCenter(line);
    modified.setPosition({ lineNumber: line, column: 1 });
    modified.focus();
    // The flash is the "this is the one you asked for" mark; it is temporary
    // on purpose, so it never reads as a saved comment of its own.
    flashRef.current?.clear();
    flashRef.current = modified.createDecorationsCollection([
      {
        range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
        options: { isWholeLine: true, className: "kin-diff-comment-flash" },
      },
    ]);
    if (flashTimerRef.current !== null) window.clearTimeout(flashTimerRef.current);
    flashTimerRef.current = window.setTimeout(() => {
      flashRef.current?.clear();
      flashRef.current = null;
      flashTimerRef.current = null;
    }, 1400);
    return true;
  }, []);
  revealLineRef.current = revealLine;

  // A tray jump or a closed comment box asks for a line. The editor may still
  // be loading (the file read, the diff computation), so the request waits in
  // the mount path instead of being dropped.
  useEffect(() => {
    if (!focusLine || focusLine.nonce === appliedFocusNonceRef.current) return;
    // A comment may live in another file: wait for that file's diff instead of
    // revealing the same line number in whatever happens to be open now.
    if (focusLine.path && focusLine.path !== path) return;
    pendingFocusRef.current = focusLine;
    if (revealLine(focusLine.line)) {
      appliedFocusNonceRef.current = focusLine.nonce;
      pendingFocusRef.current = null;
    }
  }, [focusLine, path, revealLine]);

  const onDiffMount = useCallback(
    (editor: MonacoEditor.IStandaloneDiffEditor, monaco: Monaco) => {
      diffEditorRef.current = editor;
      monacoRef.current = monaco;
      const modified = editor.getModifiedEditor();

      const applyLineChanges = () => {
        const changes = editor.getLineChanges();
        setDiffLineChanges(changes ?? []);
        if (!onCommentLineRef.current) return;
        // A comment glyph on every changed line: the entry is on the line, not
        // in a menu that makes the person describe where they are.
        glyphsRef.current?.clear();
        glyphsRef.current = modified.createDecorationsCollection(
          (changes ?? [])
            .filter((change) => change.modifiedEndLineNumber !== 0)
            .flatMap((change) =>
              Array.from(
                {
                  length: change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1,
                },
                (_, offset) => ({
                  range: new monaco.Range(
                    change.modifiedStartLineNumber + offset,
                    1,
                    change.modifiedStartLineNumber + offset,
                    1,
                  ),
                  options: {
                    glyphMarginClassName: "kin-diff-comment-glyph",
                    glyphMarginHoverMessage: {
                      value: translate("workspace.comments.actionHint"),
                    },
                  },
                }),
              ),
            ),
        );
      };
      applyLineChanges();

      const requestComment = (line: number | undefined) => {
        const changes = editor.getLineChanges();
        const model = modified.getModel();
        if (!line || !path || !model || !onCommentLineRef.current) return;
        const anchor = anchorForLine({
          path,
          line,
          lineContent: model.getLineContent(line),
          lineChanges: changes,
        });
        if (anchor) onCommentLineRef.current(anchor);
      };
      requestCommentRef.current = requestComment;

      modified.onDidChangeCursorPosition((event) => setCursorLine(event.position.lineNumber));
      modified.onMouseDown((event) => {
        if (event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
        requestComment(event.target.position?.lineNumber);
      });
      // ⌥C / Alt+C: the keyboard way to the same box, on the line the cursor
      // is already on. Part 2 re-anchors saved comments after a rerun here too.
      modified.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyC, () => {
        requestComment(modified.getPosition()?.lineNumber);
      });
      const diffListener = editor.onDidUpdateDiff(() => applyLineChanges());

      const pending = pendingFocusRef.current;
      if (pending) {
        // One frame lets the diff's own layout settle before revealing.
        window.requestAnimationFrame(() => {
          if (revealLineRef.current(pending.line)) {
            appliedFocusNonceRef.current = pending.nonce;
            pendingFocusRef.current = null;
          }
        });
      }

      editor.onDidDispose?.(() => {
        diffListener.dispose();
        glyphsRef.current?.clear();
        glyphsRef.current = null;
      });
    },
    [path],
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
      const updated = workspaceId
        ? await writeWorkspaceFile(taskId, workspaceId, path, draft)
        : await writeTaskWorkspaceFile(taskId, path, draft);
      setSaveState("saved");
      onSaved?.(updated);
    } catch (err) {
      setSaveState("error");
      setSaveError(err instanceof Error ? err.message : String(err));
    }
  }, [taskId, workspaceId, path, draft, saveState, onSaved]);

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
      // The gutter is the line-level comment entry; it only exists when the
      // page has somewhere to put a comment.
      glyphMargin: Boolean(onCommentLine),
    }),
    [diffLayout, onCommentLine],
  );

  if (!path) {
    return (
      <div className="h-full flex items-center justify-center text-strong leading-5 text-kin-muted px-6 text-center">
        {t("workspace.viewer.empty")}
      </div>
    );
  }

  // Prefer tool-derived diff when available; fall back to plain file view.
  const useDiff = Boolean(diff && (diff.original.length > 0 || diff.modified.length > 0));
  const isMd = isMarkdownPath(path);
  // Markdown preview is only available in plain (non-diff) view.
  const showMdPreview = isMd && !useDiff && mdView === "preview" && Boolean(file);
  // Editing is only offered in the plain file view. Diffs stay read-only, and a
  // truncated file must not be saved or we would clobber the unseen tail.
  // Markdown preview mode is also non-editable (switch to Code to edit).
  const canEdit = Boolean(
    editable && taskId && file && !useDiff && !file.truncated && !(isMd && mdView === "preview"),
  );
  // Keep the last good file mounted while a new path loads so Monaco is not
  // disposed/recreated on every navigation. Only blank the editor on hard error
  // with no content, or first open before any content arrives.
  const showEditor = (Boolean(file) || useDiff) && (!error || loading);
  const showError = Boolean(error) && !loading;
  const showInitialLoading = loading && !file && !useDiff;
  const openRoot = file?.root || cwd || "";
  const cursorOnChangedLine = isChangedLine(diffLineChanges, cursorLine);
  const modifiedContent =
    file?.content != null && file.content.length > 0 ? file.content : (diff?.modified ?? "");

  return (
    <div className="h-full min-h-0 flex flex-col">
      {/*
        Two rules Monaco renders by class name. They live here rather than in
        the global stylesheet because they exist only while this viewer does:
        the comment glyph in the diff's gutter, and the flash that marks the
        line a tray row jumped to.
      */}
      <style>{`
        .kin-diff-comment-glyph { cursor: pointer; }
        .kin-diff-comment-glyph::after {
          content: "💬";
          display: block;
          font-size: 11px;
          line-height: 19px;
          text-align: center;
          opacity: 0.65;
        }
        .kin-diff-comment-glyph:hover::after { opacity: 1; }
        .kin-diff-comment-flash {
          background: rgb(var(--kin-blue-rgb) / 0.2);
        }
      `}</style>
      <div className="flex-none flex items-center gap-2 border-b border-[var(--kin-hairline)] px-3 py-2 text-caption text-kin-muted">
        <span className="font-mono text-kin-secondary truncate min-w-0" title={path}>
          {path}
        </span>
        {useDiff && (
          <span className="flex-none rounded bg-kin-blue/15 px-1.5 py-0.5 text-micro font-semibold uppercase tracking-label text-kin-blue-ink">
            {t("workspace.viewer.diff")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {useDiff && (
            <div
              className="flex items-center gap-0.5 rounded-md border border-[var(--kin-hairline)] bg-[var(--kin-fill)] p-0.5"
              role="group"
              aria-label={t("workspace.viewer.diffLayout")}
            >
              {/* A pressed toggle, not a filled action: the quiet weight keeps
                  the pair's wash and the state inks override its own with `!`. */}
              <Button
                variant="quiet"
                onClick={() => setDiffLayout("inline")}
                aria-pressed={diffLayout === "inline"}
                title={t("workspace.viewer.diffInline")}
                className={[
                  "h-auto! px-1.5 py-0.5 rounded text-caption",
                  diffLayout === "inline"
                    ? "bg-kin-blue/15! text-kin-blue-ink!"
                    : "text-kin-muted! hover:text-kin-text! hover:bg-[var(--kin-fill-strong)]!",
                ].join(" ")}
              >
                {t("workspace.viewer.diffInline")}
              </Button>
              <Button
                variant="quiet"
                onClick={() => setDiffLayout("sideBySide")}
                aria-pressed={diffLayout === "sideBySide"}
                title={t("workspace.viewer.diffSideBySide")}
                className={[
                  "h-auto! px-1.5 py-0.5 rounded text-caption",
                  diffLayout === "sideBySide"
                    ? "bg-kin-blue/15! text-kin-blue-ink!"
                    : "text-kin-muted! hover:text-kin-text! hover:bg-[var(--kin-fill-strong)]!",
                ].join(" ")}
              >
                {t("workspace.viewer.diffSideBySide")}
              </Button>
            </div>
          )}
          {useDiff && (
            <div
              className="flex items-center gap-0.5 rounded-md border border-[var(--kin-hairline)] bg-[var(--kin-fill)] p-0.5"
              role="group"
              aria-label={t("workspace.viewer.diffNav")}
            >
              <Button
                variant="quiet"
                onClick={() => goToHunk("previous")}
                title={t("workspace.viewer.prevHunk")}
                aria-label={t("workspace.viewer.prevHunk")}
                className="h-auto! p-1 rounded text-kin-muted! hover:text-kin-text! hover:bg-[var(--kin-fill-strong)]!"
              >
                {/* Chevron points right by default; rotate for up/down. */}
                <IconChevron size={13} className="-rotate-90" />
              </Button>
              <Button
                variant="quiet"
                onClick={() => goToHunk("next")}
                title={t("workspace.viewer.nextHunk")}
                aria-label={t("workspace.viewer.nextHunk")}
                className="h-auto! p-1 rounded text-kin-muted! hover:text-kin-text! hover:bg-[var(--kin-fill-strong)]!"
              >
                <IconChevron size={13} className="rotate-90" />
              </Button>
            </div>
          )}
          {useDiff && onCommentLine && (
            // The same action as the line's glyph, reachable without a mouse:
            // a phone taps the line first, then this button. Disabled until the
            // cursor sits on a changed line, with the reason in the title.
            <Button
              variant="quiet"
              className="text-caption md:min-h-0 md:py-1 md:px-2"
              disabled={!cursorOnChangedLine}
              aria-label={t("workspace.comments.action")}
              title={
                cursorOnChangedLine
                  ? t("workspace.comments.actionHint")
                  : t("workspace.comments.notChanged")
              }
              onClick={() => requestCommentRef.current(cursorLine)}
            >
              {t("workspace.comments.action")}
            </Button>
          )}
          {isMd && !useDiff && file && (
            <div
              className="flex items-center gap-0.5 rounded-md border border-[var(--kin-hairline)] bg-[var(--kin-fill)] p-0.5"
              role="group"
              aria-label={t("workspace.viewer.mdView")}
            >
              <Button
                variant="quiet"
                onClick={() => setMdView("preview")}
                aria-pressed={mdView === "preview"}
                title={t("workspace.viewer.preview")}
                className={[
                  "h-auto! px-1.5 py-0.5 rounded text-caption",
                  mdView === "preview"
                    ? "bg-kin-blue/15! text-kin-blue-ink!"
                    : "text-kin-muted! hover:text-kin-text! hover:bg-[var(--kin-fill-strong)]!",
                ].join(" ")}
              >
                {t("workspace.viewer.preview")}
              </Button>
              <Button
                variant="quiet"
                onClick={() => setMdView("code")}
                aria-pressed={mdView === "code"}
                title={t("workspace.viewer.code")}
                className={[
                  "h-auto! px-1.5 py-0.5 rounded text-caption",
                  mdView === "code"
                    ? "bg-kin-blue/15! text-kin-blue-ink!"
                    : "text-kin-muted! hover:text-kin-text! hover:bg-[var(--kin-fill-strong)]!",
                ].join(" ")}
              >
                {t("workspace.viewer.code")}
              </Button>
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
              <Button
                variant="secondary"
                disabled={actionsBusy}
                onClick={() => onDiscard?.()}
                title={t("workspace.changed.discardHint")}
                aria-label={t("workspace.changed.discard")}
                className="md:h-auto! md:min-h-0 md:py-1 md:px-2 text-caption [&>span>span]:flex [&>span>span]:items-center [&>span>span]:gap-2"
              >
                <IconX size={12} />
                {t("workspace.changed.discard")}
              </Button>
              <Button
                variant="default"
                disabled={actionsBusy}
                onClick={() => onKeep?.()}
                title={t("workspace.changed.keepHint")}
                aria-label={t("workspace.changed.keep")}
                className="md:h-auto! md:min-h-0 md:py-1 md:px-2 text-caption [&>span>span]:flex [&>span>span]:items-center [&>span>span]:gap-2"
              >
                <IconCheck size={12} />
                {t("workspace.changed.keep")}
              </Button>
            </>
          )}
          {editable && file?.truncated && !useDiff && (
            <span
              className="flex-none rounded bg-kin-orange/15 px-1.5 py-0.5 text-micro font-semibold uppercase tracking-label text-kin-orange-ink"
              title={t("workspace.viewer.readOnlyTruncated")}
            >
              {t("workspace.viewer.readOnlyTruncated")}
            </span>
          )}
          {canEdit && (
            <>
              {saveState === "error" && saveError && (
                <span className="text-kin-red-ink" title={saveError}>
                  {t("workspace.viewer.saveFailed")}
                </span>
              )}
              {saveState === "saved" && !dirty && (
                <span className="text-kin-green-ink">{t("workspace.viewer.saved")}</span>
              )}
              <Button
                variant="default"
                disabled={!dirty || saveState === "saving"}
                onClick={() => void doSave()}
                title={t("workspace.viewer.save")}
                aria-label={
                  saveState === "saving" ? t("workspace.viewer.saving") : t("workspace.viewer.save")
                }
                className="md:h-auto! md:min-h-0 md:py-1 md:px-2 text-caption [&>span>span]:flex [&>span>span]:items-center [&>span>span]:gap-2"
              >
                <IconCheck size={12} />
                {saveState === "saving" ? t("workspace.viewer.saving") : t("workspace.viewer.save")}
              </Button>
            </>
          )}
          <OpenInMenu root={openRoot} relativePath={path} />
        </div>
      </div>

      <div className="flex-1 min-h-0 relative">
        {showInitialLoading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center text-strong leading-5 text-kin-secondary bg-[var(--kin-bg)]">
            {t("workspace.viewer.loading")}
          </div>
        )}
        {showError && !showEditor && (
          <div className="h-full flex items-center justify-center text-strong leading-5 text-kin-red-ink px-6 text-center">
            {error}
          </div>
        )}
        {/* A status fill takes the status foreground, and it is solid: white on
            the dark red is 3.0:1, near-black is 5.1:1, and the old 90% alpha
            pulled the fill toward the backdrop until even that was 4.3:1 — an
            error toast is the wrong place to be translucent. */}
        {showError && showEditor && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 rounded-md bg-kin-red px-3 py-1 text-body text-kin-on-status shadow-e2">
            {error}
          </div>
        )}
        {showEditor && useDiff && diff && (
          <MonacoSafe fallback={<FallbackPre text={diff.modified || diff.original} />}>
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
                <div className="h-full flex items-center justify-center text-strong leading-5 text-kin-muted">
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
              onChange={canEdit ? (next) => setDraft(next ?? "") : undefined}
              onMount={canEdit ? onEditorMount : undefined}
              options={canEdit ? { ...EDITOR_OPTIONS, readOnly: false } : EDITOR_OPTIONS}
              loading={
                <div className="h-full flex items-center justify-center text-strong leading-5 text-kin-muted">
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
    <pre className="h-full overflow-auto kin-scroll p-4 text-body font-mono text-kin-secondary whitespace-pre">
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
