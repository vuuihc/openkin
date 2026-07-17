import { Component, type ReactNode } from "react";
import Editor from "@monaco-editor/react";
import {
  formatBytes,
  type TaskWorkspaceFileResponse,
} from "../../api/client";
import { useT } from "../../i18n/react";
import "./monacoSetup";

type Props = {
  path: string | null;
  file: TaskWorkspaceFileResponse | null;
  loading: boolean;
  error: string | null;
};

const EDITOR_OPTIONS = {
  readOnly: true,
  minimap: { enabled: false },
  fontSize: 13,
  wordWrap: "on",
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderLineHighlight: "none",
  padding: { top: 12, bottom: 12 },
  scrollbar: {
    verticalScrollbarSize: 10,
    horizontalScrollbarSize: 10,
  },
} as const;

export default function CodeViewer({ path, file, loading, error }: Props) {
  const t = useT();

  if (!path) {
    return (
      <div className="h-full flex items-center justify-center text-sm text-kin-muted px-6 text-center">
        {t("workspace.viewer.empty")}
      </div>
    );
  }

  // Keep the last good file mounted while a new path loads so Monaco is not
  // disposed/recreated on every navigation. Only blank the editor on hard error
  // with no content, or first open before any content arrives.
  const showEditor = Boolean(file) && (!error || loading);
  const showError = Boolean(error) && !loading;
  const showInitialLoading = loading && !file;

  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex-none flex items-center gap-2 border-b border-[var(--kin-hairline)] px-3 py-2 text-[11.5px] text-kin-muted">
        <span className="font-mono text-kin-secondary truncate" title={path}>
          {path}
        </span>
        {file && (
          <span className="ml-auto tabular-nums shrink-0">
            {formatBytes(file.size)}
            {file.truncated ? ` · ${t("workspace.viewer.truncated")}` : ""}
            {loading ? " · …" : ""}
          </span>
        )}
      </div>

      {showError && (
        <div className="flex-none px-3 py-2">
          <div className="rounded-xl border border-[rgba(255,69,58,.25)] bg-[rgba(255,69,58,.08)] px-3 py-2 text-[12.5px] text-[#ffb4ad]">
            {error}
          </div>
        </div>
      )}

      {showInitialLoading && (
        <div className="flex-1 flex items-center justify-center text-sm text-kin-muted px-6 text-center">
          {t("workspace.viewer.loading")}{" "}
          <span className="font-mono ml-1">{path}</span>…
        </div>
      )}

      {showEditor && file && (
        <div className="flex-1 min-h-0">
          <MonacoBoundary
            fallback={
              <pre className="h-full m-0 p-3 overflow-auto kin-scroll text-[12.5px] leading-5 font-mono text-kin-secondary whitespace-pre">
                {file.content}
              </pre>
            }
          >
            <Editor
              height="100%"
              theme="vs-dark"
              path={file.path}
              language={languageForPath(file.path)}
              value={file.content}
              options={EDITOR_OPTIONS}
              loading={
                <div className="h-full flex items-center justify-center text-sm text-kin-muted">
                  {t("workspace.viewer.loading")}…
                </div>
              }
            />
          </MonacoBoundary>
        </div>
      )}

      {!showEditor && !showInitialLoading && showError && (
        <div className="flex-1 flex items-center justify-center text-sm text-kin-muted px-6 text-center">
          {t("workspace.viewer.unavailable")}
        </div>
      )}
    </div>
  );
}

class MonacoBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
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
