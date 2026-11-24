import { describe, expect, it, jest } from "@jest/globals";
import { apiFetch, listTasksPath } from "./transport";

/**
 * KIN-MOBILE-001 R2 — the RN transport adapter from ADR 0036 §2.
 *
 * It is a transport, not a second client: it builds the absolute URL from the
 * stored node origin, carries the bearer token in a header only, and maps the
 * node's answers to the three reason codes the phone needs.
 */

const ORIGIN = "https://kin.example.com";
const TOKEN = "fixture-token-not-real";

type Call = { url: string; init: RequestInit };

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as unknown as Response;
}

function recordingFetch(reply: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = jest.fn(async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init: init ?? {} });
    return reply(input);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function authorizationOf(call: Call): string | undefined {
  return (call.init.headers as Record<string, string> | undefined)?.Authorization;
}

describe("KIN-MOBILE-001 R2 transport", () => {
  it("KIN-MOBILE-001 R2: builds an absolute URL and sends the bearer only when a session exists", async () => {
    const { impl, calls } = recordingFetch(() => response(200, []));

    await apiFetch<unknown[]>(ORIGIN, listTasksPath(), { token: TOKEN, fetchImpl: impl });
    await apiFetch<unknown[]>(`${ORIGIN}/`, listTasksPath(), { fetchImpl: impl });

    expect(calls[0].url).toBe("https://kin.example.com/api/tasks?page=1&limit=20");
    expect(calls[0].init.headers).toMatchObject({
      Accept: "application/json",
      Authorization: `Bearer ${TOKEN}`,
    });
    // No session: the header is absent, not empty.
    expect(authorizationOf(calls[1])).toBeUndefined();
  });

  it("KIN-MOBILE-001 R2: never puts the token in the query string", async () => {
    const { impl, calls } = recordingFetch(() => response(200, []));

    await apiFetch<unknown[]>(ORIGIN, listTasksPath(), { token: TOKEN, fetchImpl: impl });

    expect(calls[0].url).not.toContain("token");
    expect(calls[0].url).not.toContain(TOKEN);
  });

  it.each([
    [401, "expired"],
    [400, "rejected"],
    [404, "rejected"],
    [422, "rejected"],
    [500, "unreachable"],
    [503, "unreachable"],
  ] as const)("KIN-MOBILE-001 R2: maps status %i to %s", async (status, reason) => {
    const { impl } = recordingFetch(() => response(status, { error: "refused" }));

    const result = await apiFetch<unknown>(ORIGIN, listTasksPath(), {
      token: TOKEN,
      fetchImpl: impl,
    });

    expect(result).toMatchObject({ ok: false, status, reason });
  });

  it("KIN-MOBILE-001 R2: a rejected fetch is unreachable", async () => {
    const { impl } = recordingFetch(() => {
      throw new TypeError("Network request failed");
    });

    const result = await apiFetch<unknown>(ORIGIN, listTasksPath(), {
      token: TOKEN,
      fetchImpl: impl,
    });

    expect(result).toEqual({ ok: false, status: null, reason: "unreachable" });
  });

  it("KIN-MOBILE-001 R2: a 200 returns the parsed body", async () => {
    const tasks = [{ id: "task-1", title: "Fixture" }];
    const { impl } = recordingFetch(() => response(200, tasks));

    const result = await apiFetch<typeof tasks>(ORIGIN, listTasksPath(), {
      token: TOKEN,
      fetchImpl: impl,
    });

    expect(result).toEqual({ ok: true, status: 200, data: tasks });
  });
});
