import { ApiError } from "../../api/client";

/**
 * How the file panel shows a file, decided from its name.
 *
 * The daemon decides what a raw read may be drawn as, and this is the same
 * decision on the side that asks for it: an image is fetched as bytes and drawn
 * in an <img>, a table is read as text and laid out in rows, a binary is not
 * read at all and is offered as a download, and everything else goes to the code
 * viewer as before.
 *
 * The image list matches the daemon's `rawFileType` exactly. SVG is absent on
 * purpose: it is text, the code viewer already shows it, and as a document it
 * can carry script.
 */

export type PreviewKind = "image" | "table" | "binary" | "text";

/** The image types the daemon draws inline; kept in step with `rawFileType`. */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);

/**
 * Formats that are files in the browser's sense and not text in any useful
 * sense. Unknown extensions stay text: a Makefile, a Dockerfile and a .env all
 * have no extension, and refusing to show them would be the worse mistake.
 */
const BINARY_EXTENSIONS = new Set([
  "pdf",
  "zip",
  "gz",
  "tgz",
  "tar",
  "bz2",
  "xz",
  "zst",
  "7z",
  "rar",
  "jar",
  "war",
  "class",
  "wasm",
  "exe",
  "dll",
  "so",
  "dylib",
  "o",
  "a",
  "bin",
  "db",
  "sqlite",
  "sqlite3",
  // Office documents are containers; their bytes are not what a reader wants.
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "mp3",
  "m4a",
  "mp4",
  "mov",
  "webm",
  "wav",
  "flac",
  "ogg",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "psd",
  "tif",
  "tiff",
  "heic",
  "heif",
]);

/** How a table file separates its fields. */
const TABLE_DELIMITERS: Record<string, string> = {
  csv: ",",
  tsv: "\t",
};

/** The name's extension, lowercased, without the dot. Empty when there is none. */
export function fileExtension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  const dot = name.lastIndexOf(".");
  // A leading dot is a hidden file's name, not an extension: ".bashrc".
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function previewKind(path: string): PreviewKind {
  const ext = fileExtension(path);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (ext in TABLE_DELIMITERS) return "table";
  if (BINARY_EXTENSIONS.has(ext)) return "binary";
  return "text";
}

export function tableDelimiter(path: string): string {
  return TABLE_DELIMITERS[fileExtension(path)] ?? ",";
}

/**
 * The bounds of a rendered table. A file can be a megabyte of rows; the panel is
 * a viewer, not a spreadsheet, and a person reading a change wants the shape of
 * the data, not all of it.
 */
export const TABLE_MAX_ROWS = 200;
export const TABLE_MAX_COLUMNS = 30;

export type ParsedTable = {
  rows: string[][];
  /** More rows or columns existed than the bounds allow. */
  truncated: boolean;
};

/**
 * Parse CSV/TSV text into rows, noting when the data did not fit.
 *
 * This follows the quoting rules a spreadsheet writes: a field may be wrapped in
 * double quotes to carry the delimiter or a newline, and a doubled quote inside
 * one is a literal quote. It is not a full RFC 4180 implementation and does not
 * pretend to be one — an unclosed quote is taken to run to the end of the text,
 * which is what the person reading it would assume.
 */
export function parseDelimited(text: string, delimiter: string): ParsedTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let truncated = false;
  let stopped = false;

  const endField = () => {
    if (row.length < TABLE_MAX_COLUMNS) {
      row.push(field);
    } else {
      truncated = true;
    }
    field = "";
  };
  const endRow = () => {
    endField();
    if (rows.length >= TABLE_MAX_ROWS) {
      truncated = true;
      stopped = true;
      return;
    }
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length && !stopped; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      continue;
    }
    if (ch === delimiter) {
      endField();
      continue;
    }
    if (ch === "\n") {
      endRow();
      continue;
    }
    if (ch === "\r") {
      endRow();
      if (text[i + 1] === "\n") i += 1;
      continue;
    }
    field += ch;
  }
  // A trailing newline is the end of the last row, not the start of an empty
  // one; a final field with no newline after it is still a row.
  if (!stopped && (field !== "" || row.length > 0)) {
    endRow();
  }
  return { rows, truncated };
}

/**
 * The last segment of a path, which is the name a saved file gets.
 *
 * Change-list paths are absolute and may come from a Windows machine, where the
 * separator is a backslash; the browser wants a plain file name either way.
 */
export function fileBaseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * The message to show for a failed workspace call.
 *
 * An `ApiError` usually carries the daemon's own sentence already, but a route
 * that answers with a raw body can leave the JSON envelope in the message, so
 * it is unwrapped here too. The fallback is the caller's translated sentence
 * for a failure that has nothing to say.
 */
export function workspaceErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    try {
      const parsed = JSON.parse(error.message) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error) {
        return parsed.error;
      }
    } catch {
      /* the message is already plain */
    }
    return error.message;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}
