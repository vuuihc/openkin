import { afterEach, describe, expect, it, vi } from "vitest";
import { listTasks } from "./client";

/**
 * One routine's own runs are the tasks endpoint narrowed by `routine_id`.
 *
 * The daemon has supported the filter since the routine-runs feed landed, but
 * the console only ever read the global feed, so a routine whose last run fell
 * off that page looked like it had never run. The page requests it with this
 * parameter; the request is the one thing a source pin cannot prove.
 */
function stubList(): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (input: unknown) => {
    urls.push(String(input));
    return Promise.resolve(
      new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  });
  return { urls };
}

/** The query the client actually sent, so `r1` cannot match `r10`. */
function query(url: string): URLSearchParams {
  return new URL(url, "http://kin.example.com").searchParams;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listTasks", () => {
  it("asks for one routine's runs", async () => {
    const { urls } = stubList();
    await listTasks({ routineId: "r1", limit: 10 });
    expect(query(urls[0]).get("routine_id")).toBe("r1");
    expect(query(urls[0]).get("limit")).toBe("10");
  });

  it("says nothing about routines when no filter was asked for", async () => {
    const { urls } = stubList();
    await listTasks({ limit: 5 });
    expect(query(urls[0]).has("routine_id")).toBe(false);
  });
});
