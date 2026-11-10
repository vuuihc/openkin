import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRoutine,
  deleteRoutine,
  getRoutineUnreadCount,
  listRoutineRuns,
  listRoutines,
  markAllRoutineRunsRead,
  markRoutineRunRead,
  previewRoutine,
  runRoutineNow,
} from "./client";

/**
 * A routine request names the machine that owns the routines.
 *
 * The Hub relays the request to that machine, so the parameter is the whole
 * difference between "the routines on my laptop" and "the routines on the Hub",
 * and a source pin on the page cannot prove it travels.
 */
function stubFetch(body = "{}"): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (input: unknown) => {
    urls.push(String(input));
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  });
  return urls;
}

function query(url: string): URLSearchParams {
  return new URL(url, "http://kin.example.com").searchParams;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("routine requests and their machine", () => {
  it("carries the machine on reads and writes", async () => {
    const urls = stubFetch('{"routines":[],"runs":[]}');
    await listRoutines({ limit: 100 }, "device-laptop");
    await createRoutine({ title: "t", cwd: "/code", prompt: "p" } as never, "device-laptop");
    await deleteRoutine("r-1", "device-laptop");
    await runRoutineNow("r-1", "device-laptop");
    await markRoutineRunRead("t-1", "device-laptop");
    await markAllRoutineRunsRead("device-laptop");
    await listRoutineRuns(50, "device-laptop");
    for (const url of urls) {
      expect(query(url).get("device")).toBe("device-laptop");
    }
  });

  it("carries the machine on the badge's unread count", async () => {
    // The sidebar badge sits outside the Routines page, so this call site is
    // the one easy to leave asking the Hub's own empty store.
    const urls = stubFetch('{"count":3}');
    const { count } = await getRoutineUnreadCount("device-laptop");
    expect(count).toBe(3);
    expect(new URL(urls[0], "http://kin.example.com").pathname).toBe("/api/routines/unread-count");
    expect(query(urls[0]).get("device")).toBe("device-laptop");
  });

  it("keeps the page's own parameters beside the machine", async () => {
    const urls = stubFetch('{"routines":[],"runs":[]}');
    await listRoutines({ limit: 100, q: "pr", runs: true }, "device-laptop");
    expect(query(urls[0]).get("q")).toBe("pr");
    expect(query(urls[0]).get("limit")).toBe("100");
    expect(query(urls[0]).get("runs")).toBe("1");
    expect(query(urls[0]).get("device")).toBe("device-laptop");
  });

  it("says nothing about a machine when this console's own is meant", async () => {
    const urls = stubFetch('{"routines":[],"runs":[]}');
    await listRoutines({ limit: 100 });
    expect(query(urls[0]).has("device")).toBe(false);
  });

  it("previews a rule without naming a machine", async () => {
    // The preview is arithmetic on an unsaved rule; relaying it would put a
    // round trip between a person and a calendar they are typing in.
    const urls = stubFetch('{"next_due_at":1}');
    await previewRoutine('{"kind":"daily","hour":9,"minute":0}');
    expect(query(urls[0]).has("device")).toBe(false);
  });
});
