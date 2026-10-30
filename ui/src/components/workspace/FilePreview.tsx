import { useEffect, useMemo, useState } from "react";
import { fetchFileBytes } from "../../api/client";
import { useT } from "../../i18n/react";
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
    <div className="flex flex-col items-center gap-1">
      <button
        type="button"
        onClick={() => void download()}
        disabled={busy}
        className="kin-btn-secondary mt-2 inline-flex items-center px-3 py-1.5 text-caption disabled:opacity-60"
      >
        {busy ? t("workspace.viewer.downloading") : t("workspace.viewer.download")}
      </button>
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
}: {
  name: string;
  downloadURL: string;
  message: string;
  /** The message is the answer to something that just failed, so say it. */
  announce?: boolean;
}) {
  return (
    <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-strong font-medium text-kin-text break-all">{name}</div>
      <div role={announce ? "alert" : undefined} className="text-caption text-kin-muted max-w-md">
        {message}
      </div>
      <DownloadButton name={name} downloadURL={downloadURL} />
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
    return (
      <div
        role="status"
        className="flex-1 flex items-center justify-center text-strong text-kin-muted"
      >
        {t("workspace.viewer.loading")}
      </div>
    );
  }
  if (error) {
    return (
      <div
        role="alert"
        className="flex-1 flex items-center justify-center px-6 text-center text-strong text-kin-muted"
      >
        {error}
      </div>
    );
  }
  if (!parsed || parsed.rows.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-6 text-center text-strong text-kin-muted">
        {t("workspace.viewer.tableEmpty")}
      </div>
    );
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
