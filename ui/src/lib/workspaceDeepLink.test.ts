import { describe, expect, it } from "vitest";
import {
  dropSearchParam,
  parseWorkspaceLink,
  patchWorkspaceLink,
} from "./workspaceDeepLink";

/**
 * KIN-RESULT-002: the files panel's place lives in the address.
 *
 * `/tasks/<id>?panel=files&file=<repo-relative path>` is one of three states
 * (conversation, file list, one file), and the query is edited as bytes: a
 * neighbouring `%20`, a `+`, another parameter and its order are not this
 * module's to rewrite. `URLSearchParams.toString()` would re-encode all of
 * them, which is why these functions take and return the raw search string.
 *
 * The path is untrusted input from a link. It is decoded once here and refused
 * unless it is clean and repo-relative, because the page resolves what it is
 * given against the task's checkout and would otherwise accept an absolute
 * path that happens to sit inside it.
 */

describe("workspace deep link", () => {
  it("reads the three states: closed, list, file", () => {
    expect(parseWorkspaceLink("")).toBeNull();
    expect(parseWorkspaceLink("?focus=ap-1")).toBeNull();

    expect(parseWorkspaceLink("?panel=files")).toEqual({
      panel: "files",
      file: null,
      explicit: true,
    });
    expect(parseWorkspaceLink("?panel=files&file=src/a.ts")).toEqual({
      panel: "files",
      file: "src/a.ts",
      explicit: true,
    });
  });

  it("drops a file that arrives without panel=files", () => {
    // A leftover `file` is not a link into the panel: only `panel=files` opens
    // it. The path is reported as absent, and the caller drops the stale key.
    expect(parseWorkspaceLink("?file=src/a.ts")).toEqual({
      panel: "files",
      file: null,
      explicit: false,
    });
    expect(dropSearchParam("?file=src/a.ts", "file")).toBe("");
    expect(dropSearchParam("?focus=ap-1&file=src/a.ts", "file")).toBe("?focus=ap-1");
  });

  it("refuses a file that is not a clean repo-relative path", () => {
    const decoded = [
      "/etc/passwd",
      "//host/x",
      "\\\\host\\share",
      "C:\\x",
      "C:/x",
      "https://x/y",
      "../x",
      "a/../../x",
      "a\\..\\b",
      "a//b",
      "./x",
      "src/",
      "a\u0000b",
      "a\nb",
      " leading.ts",
      "",
      ".",
      "..",
    ];
    for (const path of decoded) {
      const search = `?panel=files&file=${encodeURIComponent(path)}`;
      expect(parseWorkspaceLink(search), path).toEqual({
        panel: "files",
        file: null,
        explicit: true,
      });
      // A refusal keeps the panel and drops only the file.
      expect(patchWorkspaceLink(search, { panel: "files", file: null }), path).toBe(
        "?panel=files",
      );
    }

    // Malformed escapes, and an escape that decodes to a traversal, are refused
    // without throwing.
    for (const raw of ["%2e%2e%2fx", "..%2Fx", "%zz", "src%2F..%2Fb"]) {
      expect(parseWorkspaceLink(`?panel=files&file=${raw}`), raw).toEqual({
        panel: "files",
        file: null,
        explicit: true,
      });
    }

    for (const path of ["src/a.ts", "docs/x.md", "a/b/c.ts", "src/a b.ts", "src/ünïcode.ts"]) {
      expect(parseWorkspaceLink(`?panel=files&file=${encodeURIComponent(path)}`), path).toEqual({
        panel: "files",
        file: path,
        explicit: true,
      });
    }
  });

  it("keeps every other parameter byte for byte, including %20 and order", () => {
    const search = "?focus=ap-1&panel=files&file=src/a%20b.ts&z=1";

    // A new file is written in place; `focus`, `z` and their order survive.
    expect(patchWorkspaceLink(search, { panel: "files", file: "src/c.ts" })).toBe(
      "?focus=ap-1&panel=files&file=src/c.ts&z=1",
    );

    // The same file keeps its original encoding rather than being re-encoded.
    expect(patchWorkspaceLink(search, { panel: "files", file: "src/a b.ts" })).toBe(search);
    // Even when the original used a different-but-equivalent encoding, this
    // module does not rewrite bytes it was not asked to change.
    const alias = "?panel=files&file=src%2Fa%20b.ts";
    expect(patchWorkspaceLink(alias, { panel: "files", file: "src/a b.ts" })).toBe(alias);

    // Closing removes only the two keys this module owns.
    expect(patchWorkspaceLink(search, null)).toBe("?focus=ap-1&z=1");

    // `+` is a literal here, not a space that gets rewritten.
    expect(patchWorkspaceLink("?a=1+2&panel=files&file=src/a.ts", { panel: "files", file: "src/b.ts" })).toBe(
      "?a=1+2&panel=files&file=src/b.ts",
    );

    // Opening on a conversation appends without touching what was there.
    expect(patchWorkspaceLink("?z=1", { panel: "files", file: "src/a b.ts" })).toBe(
      "?z=1&panel=files&file=src/a%20b.ts",
    );
  });

  it("refused file keeps the panel and drops only the file", () => {
    const search = "?panel=files&file=../../etc/passwd&z=1";
    const link = parseWorkspaceLink(search);
    expect(link).toEqual({ panel: "files", file: null, explicit: true });
    expect(patchWorkspaceLink(search, { panel: "files", file: link?.file ?? null })).toBe(
      "?panel=files&z=1",
    );
  });

  it("leaves an unknown panel value untouched", () => {
    expect(parseWorkspaceLink("?panel=publish")).toBeNull();
    expect(parseWorkspaceLink("?panel=junk&file=src/a.ts")).toBeNull();
    expect(parseWorkspaceLink("?panel=")).toBeNull();
    // `panel` is another surface's word here: the patcher does not take it over.
    expect(patchWorkspaceLink("?panel=publish&z=1", null)).toBe("?panel=publish&z=1");
    expect(patchWorkspaceLink("?panel=publish&z=1", { panel: "files", file: null })).toBe(
      "?panel=publish&z=1",
    );
  });

  it("drops one parameter without re-encoding the rest", () => {
    // The focus consumer's write: only `focus` goes; the file keeps `%20`.
    expect(dropSearchParam("?focus=ap-1&panel=files&file=src/a%20b.ts&z=1", "focus")).toBe(
      "?panel=files&file=src/a%20b.ts&z=1",
    );
    expect(dropSearchParam("?focus=ap-1", "focus")).toBe("");
    expect(dropSearchParam("?z=1+2&focus=x", "focus")).toBe("?z=1+2");
    // An absent key is a no-op, down to the bytes.
    expect(dropSearchParam("?z=1+2", "focus")).toBe("?z=1+2");
    expect(dropSearchParam("", "focus")).toBe("");
  });
});
