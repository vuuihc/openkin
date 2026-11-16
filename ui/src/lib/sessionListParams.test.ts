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

  it("carries the status filter to the daemon", () => {
    // Status is applied by the server, not over the loaded page: the page is
    // 100 rows, and "no running chats" about a page that merely ended is a
    // wrong answer, not a slow one.
    expect(sessionListParams("", "running")).toEqual({
      limit: LIST_LIMIT,
      status: "running",
    });
    expect(sessionListParams("note", "failed")).toEqual({
      limit: SEARCH_LIMIT,
      q: "note",
      status: "failed",
    });
  });

  it("drops an empty status instead of sending status=", () => {
    // An empty value would be a filter for a status nothing has: the daemon
    // compares it exactly, so every row would vanish.
    expect(sessionListParams("", "")).toEqual(sessionListParams(""));
    expect(sessionListParams("note", "")).not.toHaveProperty("status");
  });

  it("asks for the other side of the archive, never for both", () => {
    // The daemon reads `archived` as a side, not a widening: absent means the
    // live list, `1` means only archived rows. Sending `archived: false`
    // would be a parameter the daemon rejects, so absence is the live list.
    expect(sessionListParams("", "", true)).toEqual({ limit: LIST_LIMIT, archived: true });
    expect(sessionListParams("note", "failed", true)).toEqual({
      limit: SEARCH_LIMIT,
      q: "note",
      status: "failed",
      archived: true,
    });
    expect(sessionListParams("", "", false)).toEqual({ limit: LIST_LIMIT });
    expect(sessionListParams("note")).not.toHaveProperty("archived");
  });
});
