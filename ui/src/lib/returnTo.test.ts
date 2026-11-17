import { describe, expect, it } from "vitest";
import { returnToFrom, safeReturnTo } from "./returnTo";

/**
 * Where a sign-in round trip comes back to (KIN-RESULT-002 「登录」).
 *
 * The value travels through the provider and comes back to the Hub, which runs
 * its own check (`safeReturnTo` in `internal/api/auth.go`). This side mirrors
 * that contract: a local absolute path, byte for byte, and never another
 * origin. Sending the path alone dropped the query and the fragment, so a
 * filtered list and a `#frag` deep link both came back as their bare page.
 */
describe("the page a sign-in returns to", () => {
  it("keeps the query string and fragment of the page the reader was on", () => {
    // `%20` stays `%20` and the parameter order is untouched: a
    // `URL`/`URLSearchParams` round trip would rewrite both in the address bar
    // the person comes back to.
    expect(
      returnToFrom({
        pathname: "/tasks/t1",
        search: "?panel=files&file=a%20b.html",
        hash: "#frag",
      }),
    ).toBe("/tasks/t1?panel=files&file=a%20b.html#frag");
  });

  it("keeps a bare path untouched", () => {
    expect(returnToFrom({ pathname: "/routines", search: "", hash: "" })).toBe("/routines");
  });

  it("falls back to the root when the path is empty", () => {
    expect(returnToFrom({ pathname: "", search: "", hash: "" })).toBe("/");
  });

  it("refuses a protocol-relative value", () => {
    // `//evil.example/x` is a different origin with an empty scheme, so a
    // freshly authenticated browser would land there instead.
    expect(safeReturnTo("//evil.example/x")).toBe("/");
  });

  it("refuses a backslash escape", () => {
    // Browsers read `/\evil.example/x` the same way they read `//…`.
    expect(safeReturnTo("/\\evil.example/x")).toBe("/");
  });

  it("refuses an absolute URL", () => {
    expect(safeReturnTo("https://evil.example/x")).toBe("/");
  });

  it("trims surrounding whitespace", () => {
    expect(safeReturnTo("  /tasks/t1?x=1  ")).toBe("/tasks/t1?x=1");
  });
});
