import { describe, expect, it } from "vitest";
import { LIST_LIMIT, sessionListParams, SEARCH_LIMIT } from "./sessionListParams";

describe("sessionListParams", () => {
  it("asks for the recent page and no query when the field is empty", () => {
    expect(sessionListParams("")).toEqual({ limit: LIST_LIMIT });
    expect(sessionListParams("   ")).toEqual({ limit: LIST_LIMIT });
  });

  it("asks for more rows and carries the query when searching", () => {
    expect(sessionListParams("note")).toEqual({ limit: SEARCH_LIMIT, q: "note" });
    expect(SEARCH_LIMIT).toBeGreaterThan(LIST_LIMIT);
  });

  it("trims the query the same way the field and the daemon do", () => {
    expect(sessionListParams("  note  ")).toEqual({ limit: SEARCH_LIMIT, q: "note" });
  });

  it("never sends an empty q", () => {
    // `q=` empty would still be a query as far as the URL is concerned; the
    // daemon treats it as absent, but the list key would differ from the
    // unfiltered one and the page would fetch the same rows twice.
    expect(sessionListParams("")).not.toHaveProperty("q");
  });
});
