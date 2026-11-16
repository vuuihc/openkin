import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client";
import {
  TABLE_MAX_COLUMNS,
  TABLE_MAX_ROWS,
  fileBaseName,
  fileExtension,
  parseDelimited,
  previewKind,
  tableDelimiter,
  workspaceErrorMessage,
} from "./workspacePreview";

describe("previewKind", () => {
  it("draws the image types the daemon serves inline", () => {
    for (const name of [
      "shot.png",
      "shot.PNG",
      "photo.jpeg",
      "photo.jpg",
      "anim.gif",
      "shot.webp",
      "shot.bmp",
      "favicon.ico",
      "shot.avif",
      "/repo/assets/logo.png",
    ]) {
      expect([name, previewKind(name)]).toEqual([name, "image"]);
    }
  });

  it("keeps SVG with the code viewer", () => {
    // SVG is text, and as a document it can carry script. It is shown the way
    // every other text file is, never drawn as an image.
    expect(previewKind("logo.svg")).toBe("text");
  });

  it("lays CSV and TSV out as tables", () => {
    expect(previewKind("data.csv")).toBe("table");
    expect(previewKind("DATA.CSV")).toBe("table");
    expect(previewKind("data.tsv")).toBe("table");
    expect(tableDelimiter("data.csv")).toBe(",");
    expect(tableDelimiter("data.tsv")).toBe("\t");
    // An unknown extension is not a table; the comma default never applies.
    expect(tableDelimiter("notes.txt")).toBe(",");
  });

  it("offers the formats the browser cannot draw as a download", () => {
    for (const name of [
      "report.pdf",
      "bundle.zip",
      "app.wasm",
      "track.mp4",
      "font.woff2",
      "letter.docx",
      "budget.xlsx",
      "deck.pptx",
    ]) {
      expect([name, previewKind(name)]).toEqual([name, "binary"]);
    }
  });

  it("treats files with no extension and unknown ones as text", () => {
    // A Makefile, a Dockerfile and a .env are text with no extension; a .dat
    // may be either, and the text read's refusal is a better answer than a
    // download link that was never needed.
    for (const name of ["Makefile", "Dockerfile", ".bashrc", "notes.txt", "main.go", "data.dat"]) {
      expect([name, previewKind(name)]).toEqual([name, "text"]);
    }
  });

  it("reads the extension from the file name, not the directory", () => {
    expect(fileExtension("/repo/v1.2/README")).toBe("");
    expect(fileExtension("C:\\repo\\shot.png")).toBe("png");
    expect(fileExtension(".bashrc")).toBe("");
    expect(fileExtension("archive.tar.gz")).toBe("gz");
  });
});

describe("parseDelimited", () => {
  const rows = (text: string, delimiter = ",") => parseDelimited(text, delimiter);

  it("splits rows and fields", () => {
    expect(rows("a,b\n1,2\n").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(rows("a\tb\tc", "\t").rows).toEqual([["a", "b", "c"]]);
  });

  it("does not invent a row after a trailing newline", () => {
    expect(rows("a,b\n").rows).toEqual([["a", "b"]]);
    expect(rows("a,b\r\n").rows).toEqual([["a", "b"]]);
    // A blank line inside the data is a row with one empty field, because that
    // is what the file says.
    expect(rows("a\n\nb\n").rows).toEqual([["a"], [""], ["b"]]);
  });

  it("reads a quoted field with a delimiter in it", () => {
    expect(rows('name,note\n"Smith, John",hi\n').rows).toEqual([
      ["name", "note"],
      ["Smith, John", "hi"],
    ]);
  });

  it("reads a doubled quote as one quote", () => {
    expect(rows('a\n"say ""hi"""\n').rows).toEqual([["a"], ['say "hi"']]);
  });

  it("reads a newline inside a quoted field", () => {
    expect(rows('a,b\n"line one\nline two",2\n').rows).toEqual([
      ["a", "b"],
      ["line one\nline two", "2"],
    ]);
  });

  it("keeps an unclosed quote's text rather than dropping it", () => {
    // A truncated file is the common way this happens. What was written is
    // still the content, and showing it beats showing nothing.
    expect(rows('a\n"unfinished\nmore').rows).toEqual([["a"], ["unfinished\nmore"]]);
  });

  it("stops at the row bound and says so", () => {
    const text = Array.from({ length: TABLE_MAX_ROWS + 1 }, (_, i) => `row${i}`).join("\n");
    const parsed = rows(text);
    expect(parsed.rows).toHaveLength(TABLE_MAX_ROWS);
    expect(parsed.rows[TABLE_MAX_ROWS - 1]).toEqual([`row${TABLE_MAX_ROWS - 1}`]);
    expect(parsed.truncated).toBe(true);
  });

  it("does not call a table truncated when it exactly fits", () => {
    const text = Array.from({ length: TABLE_MAX_ROWS }, (_, i) => `row${i}`).join("\n");
    const parsed = rows(text);
    expect(parsed.rows).toHaveLength(TABLE_MAX_ROWS);
    expect(parsed.truncated).toBe(false);
  });

  it("cuts a wide row at the column bound and says so", () => {
    const wide = Array.from({ length: TABLE_MAX_COLUMNS + 1 }, (_, i) => `c${i}`).join(",");
    const parsed = rows(wide);
    expect(parsed.rows[0]).toHaveLength(TABLE_MAX_COLUMNS);
    expect(parsed.rows[0][TABLE_MAX_COLUMNS - 1]).toBe(`c${TABLE_MAX_COLUMNS - 1}`);
    expect(parsed.truncated).toBe(true);
  });

  it("reads nothing from an empty file", () => {
    expect(rows("")).toEqual({ rows: [], truncated: false });
  });
});

describe("fileBaseName", () => {
  it("names a saved file after its last segment, on either separator", () => {
    expect(fileBaseName("/repo/assets/shot.png")).toBe("shot.png");
    // A change row from a Windows machine reaches the panel with backslashes.
    expect(fileBaseName("C:\\repo\\assets\\shot.png")).toBe("shot.png");
    expect(fileBaseName("shot.png")).toBe("shot.png");
  });
});

describe("workspaceErrorMessage", () => {
  it("shows the daemon's own sentence", () => {
    expect(workspaceErrorMessage(new ApiError(400, "file exceeds 4194304 bytes"), "fallback")).toBe(
      "file exceeds 4194304 bytes",
    );
  });

  it("unwraps a message that still carries the JSON envelope", () => {
    // A streaming route throws the raw body, which is the daemon's envelope.
    expect(workspaceErrorMessage(new ApiError(500, '{"error":"git failed"}'), "fallback")).toBe(
      "git failed",
    );
  });

  it("falls back only when the failure has nothing to say", () => {
    expect(workspaceErrorMessage(new Error("offline"), "fallback")).toBe("offline");
    expect(workspaceErrorMessage(undefined, "fallback")).toBe("fallback");
  });
});
