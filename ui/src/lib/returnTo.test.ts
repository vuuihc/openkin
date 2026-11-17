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

  it("refuses a percent-encoded tab before the first segment", () => {
    // It starts with one `/` and is neither `//` nor `/\`, so the raw check
    // passes -- but any hop that decodes once (`/%09/…` -> `//…`) hands a
    // freshly authenticated browser to another origin.
    expect(safeReturnTo("/%09/evil.example.com")).toBe("/");
  });

  it.each([
    ["/%0d%0a/evil.example.com", "/"],
    ["/%00evil.example.com", "/"],
    ["/%7fevil.example.com", "/"],
    ["/%2F/evil.example.com", "/"],
    ["/%2f%2fevil.example.com", "/"],
    ["/%5Cevil.example.com", "/"],
    ["/%2509/evil.example.com", "/"], // double-encoded: one decode is not enough
    ["/a%zz", "/"], // malformed escape
    ["/%80evil.example.com", "/"], // not valid UTF-8: decodeURIComponent throws
    ["/a%25b", "/"], // the second decode finds `%b`, also malformed
    ["/\t/evil.example.com", "/"], // a literal tab: WHATWG strips it, leaving `//host`
    ["/caf%C3%A9", "/caf%C3%A9"], // a harmless escape comes back untouched
    ["/tasks/a%20b", "/tasks/a%20b"],
    ["/tasks/t1?panel=files&file=a%20b.html#frag", "/tasks/t1?panel=files&file=a%20b.html#frag"],
    // The decoded slash lives in the query, which does not decide the origin.
    ["/tasks/t1?panel=files&file=src%2Fa%20b.ts", "/tasks/t1?panel=files&file=src%2Fa%20b.ts"],
    ["/settings", "/settings"],
    ["  /settings  ", "/settings"],
  ])("safeReturnTo(%s) is %s", (input, want) => {
    expect(safeReturnTo(input)).toBe(want);
  });

  it("refuses an encoded tab arriving as the browser pathname", () => {
    // The location is handed in, so a crafted path reaches the same check
    // without `window` and without the router.
    expect(returnToFrom({ pathname: "/%09/evil.example.com", search: "", hash: "" })).toBe("/");
  });
});
