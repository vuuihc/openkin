import { useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchFileBytes, formatBytes } from "../../api/client";
import { useT } from "../../i18n/react";
import Button from "../ui/Button";
import OpenInMenu from "./OpenInMenu";
import { buildPreviewDocument, previewDocumentIsEmpty } from "./htmlPreview";
import {
  TABLE_MAX_COLUMNS,
  TABLE_MAX_ROWS,
  parseDelimited,
  fileBaseName,
  tableDelimiter,
  workspaceErrorMessage,
  type ParsedTable,
} from "./workspacePreview";

/** Saves bytes the viewer already fetched, under the file's own name. */
function saveBytes(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileBaseName(name);
  // Firefox only follows a click on an anchor that is in the document.
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // The browser may still be reading the blob when this returns, and revoking
  // too early cancels the save rather than freeing anything sooner. A minute is
  // long enough for the download to have started, and the page drops the URL
  // anyway when it unloads.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * The one action a file the panel cannot draw still has: save it.
 *
 * The bytes are fetched rather than linked, so a refusal — a file over the
 * preview cap, a workspace on another machine — arrives as the daemon's own
 * message instead of a saved JSON error page.
 */
function DownloadButton({ name, downloadURL }: { name: string; downloadURL: string }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      saveBytes(await fetchFileBytes(downloadURL), name);
    } catch (err) {
      setError(workspaceErrorMessage(err, t("workspace.viewer.downloadFailed")));
    } finally {
      setBusy(false);
    }
  };

  return (
    // Download is a peer of "Open in…", so it wears the same facade and the
    // same geometry; a raw `<button>` with its own padding made the two
    // side-by-side controls different heights. The alert stays in this column
    // under the button, and `DownloadPreview` top-aligns the row so a failed
    // download never pulls the neighbouring control out of line.
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="secondary"
        onClick={() => void download()}
        disabled={busy}
        className="flex-none px-2 py-1 text-caption"
      >
        {busy ? t("workspace.viewer.downloading") : t("workspace.viewer.download")}
      </Button>
      {error && (
        <div role="alert" className="text-caption text-kin-muted max-w-md">
          {error}
        </div>
      )}
    </div>
  );
}

type ImageState =
  { status: "loading" } | { status: "ready"; url: string } | { status: "failed"; message: string };

/**
 * An image, fetched as bytes and drawn where the editor would be.
 *
 * A failed load is not an error dialog: the file exists, and its bytes may be
 * unreachable for reasons the panel cannot fix (a workspace on another machine,
 * a file over the preview cap). It says why and offers the download, which is a
 * different route — streamed, uncapped — so it can still succeed when the
 * preview cannot.
 */
export function ImagePreview({
  name,
  previewURL,
  downloadURL,
}: {
  name: string;
  previewURL: string;
  downloadURL: string;
}) {
  const t = useT();
  const [state, setState] = useState<ImageState>({ status: "loading" });

  useEffect(() => {
    let live = true;
    let objectURL: string | null = null;
    setState({ status: "loading" });
    fetchFileBytes(previewURL)
      .then((blob) => {
        if (!live) return;
        objectURL = URL.createObjectURL(blob);
        setState({ status: "ready", url: objectURL });
      })
      .catch((err: unknown) => {
        if (live) {
          setState({
            status: "failed",
            message: workspaceErrorMessage(err, t("workspace.viewer.imageFailed")),
          });
        }
      });
    return () => {
      live = false;
      if (objectURL) URL.revokeObjectURL(objectURL);
    };
  }, [previewURL, t]);

  if (state.status === "loading") {
    return (
      <div
        role="status"
        className="flex-1 flex items-center justify-center text-strong text-kin-muted"
      >
        {t("workspace.viewer.loading")}
      </div>
    );
  }
  if (state.status === "failed") {
    return (
      <DownloadPreview name={name} downloadURL={downloadURL} message={state.message} announce />
    );
  }
  return (
    <div className="flex-1 min-h-0 overflow-auto flex items-center justify-center p-4 bg-[var(--kin-bg)]">
      <img
        src={state.url}
        alt={name}
        // The bytes arrived, but they are not an image this browser can decode.
        onError={() => setState({ status: "failed", message: t("workspace.viewer.imageFailed") })}
        className="max-w-full max-h-full object-contain rounded-md shadow-e1"
      />
    </div>
  );
}

/**
 * A file the browser cannot draw: its name, why it is not shown, and the one
 * action that helps.
 */
export function DownloadPreview({
  name,
  downloadURL,
  message,
  announce = false,
  openIn,
}: {
  name: string;
  downloadURL: string;
  message: string;
  /** The message is the answer to something that just failed, so say it. */
  announce?: boolean;
  /**
   * Where the file lives, so a desktop shell can offer "Open in…" next to the
   * download. Optional: the failed-image caller has no workspace path to open.
   */
  openIn?: { root: string; relativePath: string | null };
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-strong font-medium text-kin-text break-all">{name}</div>
      <div role={announce ? "alert" : undefined} className="text-caption text-kin-muted max-w-md">
        {message}
      </div>
      {/*
        Top-aligned, not centred: the download column grows downward when its
        alert appears, and centring would move "Open in…" up with it. The menu
        keeps its word here — this pane has room, and the compact viewers that
        hide it below `sm` are not this one.
      */}
      <div className="mt-2 flex flex-wrap items-start justify-center gap-2">
        <DownloadButton name={name} downloadURL={downloadURL} />
        {openIn && (
          <OpenInMenu
            root={openIn.root}
            relativePath={openIn.relativePath}
            alwaysShowLabel
          />
        )}
      </div>
    </div>
  );
}

export type FilePaneNoticeKind = "loading" | "error" | "empty" | "truncated";

/**
 * The role each text state carries. Loading and a truncated read are
 * announcements (`status`); a refusal is an alert; an empty file is simply the
 * pane's caption and must not talk over the reader.
 */
const NOTICE_ROLE: Record<FilePaneNoticeKind, "status" | "alert" | undefined> = {
  loading: "status",
  truncated: "status",
  error: "alert",
  empty: undefined,
};

/**
 * The text a preview pane shows when it has no body to draw: waiting, refused,
 * empty, or cut short. One primitive so the table and HTML panes say these the
 * same way, with the same calm weight and the same live-region contract.
 *
 * `action` is the one thing the reader can do about the state — today only a
 * failed read's "try again". It sits under the sentence rather than beside it,
 * so a narrow phone column keeps the reason readable at full width.
 */
export function FilePaneNotice({
  kind,
  children,
  action,
}: {
  kind: FilePaneNoticeKind;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role={NOTICE_ROLE[kind]}
      className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center text-strong text-kin-muted"
    >
      <div className="min-w-0">{children}</div>
      {action}
    </div>
  );
}

/**
 * A CSV or TSV laid out as a table: the first row is the header, the rest are
 * body rows, and every bound that cut the file short is stated.
 */
export function DelimitedTablePane({
  path,
  content,
  loading,
  error,
  truncated,
  onShowCode,
}: {
  path: string;
  content: string | null;
  loading: boolean;
  error: string | null;
  /** The read stopped early, so even a short table may be missing rows. */
  truncated: boolean;
  /** Shows the file in the editor instead, which is where it can be edited. */
  onShowCode: () => void;
}) {
  const t = useT();
  const delimiter = tableDelimiter(path);
  const parsed = useMemo<ParsedTable | null>(
    () => (content === null ? null : parseDelimited(content, delimiter)),
    [content, delimiter],
  );

  if (loading) {
    return <FilePaneNotice kind="loading">{t("workspace.viewer.loading")}</FilePaneNotice>;
  }
  if (error) {
    return <FilePaneNotice kind="error">{error}</FilePaneNotice>;
  }
  if (!parsed || parsed.rows.length === 0) {
    return <FilePaneNotice kind="empty">{t("workspace.viewer.tableEmpty")}</FilePaneNotice>;
  }

  const [header, ...body] = parsed.rows;
  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[var(--kin-bg)]">
      <div className="flex-none flex items-center justify-end border-b border-[var(--kin-hairline)] px-2 py-1">
        {/*
          The table is a reading view. The source is where the bytes are, and
          for a writable generation it is the only place this file can be
          edited — so it stays one click away.
        */}
        <button
          type="button"
          onClick={onShowCode}
          className="rounded-md px-2 py-1 text-caption text-kin-muted hover:text-kin-text hover:bg-[var(--kin-fill-strong)] transition-colors"
        >
          {t("workspace.viewer.code")}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="min-w-full border-collapse text-caption font-mono">
          <thead className="sticky top-0 bg-[var(--kin-fill)] shadow-e1">
            <tr>
              {header.map((cell, column) => (
                <th
                  key={column}
                  scope="col"
                  className="border-b border-[var(--kin-hairline-strong)] px-2 py-1 text-left font-semibold text-kin-text whitespace-nowrap"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r} className="hover:bg-[var(--kin-fill)]">
                {row.map((cell, c) => (
                  <td
                    key={c}
                    className="border-b border-[var(--kin-hairline)] px-2 py-1 text-kin-secondary align-top whitespace-pre"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {truncated && (
          // The read itself stopped early — a large file on a remote machine,
          // say — so the table can be missing rows the parser never saw.
          <div
            role="status"
            className="px-3 py-2 text-caption text-kin-muted border-t border-[var(--kin-hairline)]"
          >
            {t("workspace.viewer.tableIncomplete")}
          </div>
        )}
        {parsed.truncated && (
          // A table that stopped early looks complete; the caption is the only
          // thing that says it is not.
          <div className="px-3 py-2 text-caption text-kin-muted border-t border-[var(--kin-hairline)]">
            {t("workspace.viewer.tableTruncated", {
              rows: TABLE_MAX_ROWS,
              columns: TABLE_MAX_COLUMNS,
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The one control the HTML pane adds: whether the file is read as a page or as
 * its source. It is the same segmented pill the Markdown view uses — one
 * bordered group, a blue wash on the pressed segment — so the two ways of
 * reading a file are recognised the same way. `aria-pressed` says which one is
 * showing.
 */
export function HtmlViewToggle({
  view,
  onChange,
}: {
  view: "preview" | "code";
  onChange: (view: "preview" | "code") => void;
}) {
  const t = useT();
  const options = [
    { value: "preview" as const, label: t("workspace.viewer.preview") },
    { value: "code" as const, label: t("workspace.viewer.code") },
  ];
  return (
    <div
      role="group"
      aria-label={t("workspace.viewer.htmlView")}
      className="flex flex-none items-center gap-0.5 rounded-md border border-[var(--kin-hairline)] bg-[var(--kin-fill)] p-0.5"
    >
      {options.map((option) => (
        <Button
          key={option.value}
          variant="quiet"
          aria-pressed={view === option.value}
          onClick={() => onChange(option.value)}
          // The facade drops its floor at `sm`, which would take 44px away on
          // an iPad; the caller's floor carries `!` like the composer pickers.
          // A wide container keeps the compact pill the Markdown view uses.
          className={[
            "min-h-11! px-2 text-caption md:h-auto! md:min-h-0! md:px-1.5 md:py-0.5",
            view === option.value
              ? "bg-kin-blue/15! text-kin-blue-ink!"
              : "text-kin-muted! hover:text-kin-text! hover:bg-[var(--kin-fill-strong)]!",
          ].join(" ")}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}

/**
 * A self-contained HTML file drawn as a page.
 *
 * The page is built from content the panel already read: no second request,
 * no backend route, no new origin. `HtmlPreviewPane` never renders a page the
 * read did not finish — a truncated file is the source's job, not a guess at
 * what the rest of the markup would have been.
 */
export function HtmlPreviewPane({
  path,
  content,
  size,
  openRoot,
  loading,
  error,
  truncated,
  onShowCode,
}: {
  path: string;
  content: string | null;
  size: number | null;
  /** Task workspace root, for the source view's "Open in…" menu. */
  openRoot: string;
  loading: boolean;
  error: string | null;
  /** The read stopped early, so the page would be a half-drawn one. */
  truncated: boolean;
  /** Shows the file in the editor instead, which is where it can be edited. */
  onShowCode: () => void;
}) {
  const t = useT();
  const documentText = useMemo(
    () => (content === null ? "" : buildPreviewDocument(content)),
    [content],
  );

  if (loading) {
    return <FilePaneNotice kind="loading">{t("workspace.viewer.loading")}</FilePaneNotice>;
  }
  if (error) {
    return <FilePaneNotice kind="error">{error}</FilePaneNotice>;
  }
  if (content === null || previewDocumentIsEmpty(documentText)) {
    return <FilePaneNotice kind="empty">{t("workspace.viewer.htmlEmpty")}</FilePaneNotice>;
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-[var(--kin-bg)]">
      {/*
        The same two-row file header the source view draws: what the file is,
        then the controls that change how it is read. The page and its source
        are two views of one file, so the switch must not look like a bar of
        its own laid over the editor.
      */}
      <div
        data-testid="html-preview-header"
        className="flex-none border-b border-[var(--kin-hairline)] px-3 py-2 text-caption text-kin-muted"
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-kin-secondary truncate min-w-0" title={path}>
            {path}
          </span>
          {size != null && <span className="flex-none tabular-nums">{formatBytes(size)}</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <HtmlViewToggle view="preview" onChange={(view) => view === "code" && onShowCode()} />
          <OpenInMenu root={openRoot} relativePath={path} />
        </div>
      </div>
      {truncated ? (
        // The read itself stopped early, so the markup that is here is not the
        // page that was written. Say so, and keep the source one click away.
        <FilePaneNotice kind="truncated">{t("workspace.viewer.htmlIncomplete")}</FilePaneNotice>
      ) : (
        <iframe
          // An empty sandbox is every restriction at once: no scripts, no
          // forms, no popups, no top navigation, and an opaque origin.
          sandbox=""
          srcDoc={documentText}
          title={path}
          // The page is a light canvas of its own; Kin's dark scheme must not
          // make a page with no colours of its own unreadable.
          style={{ colorScheme: "light" }}
          className="flex-1 w-full min-h-0 border-0 bg-white"
        />
      )}
    </div>
  );
}
