import { describe, expect, it, jest } from "@jest/globals";
import { apiFetch, listProjectsPath, listTasksPath } from "./transport";

/**
 * KIN-MOBILE-001 R2 — the transport's two bounds (AGENTS.md §13).
 *
 * The other transport behaviours (absolute URL, header-only bearer, status
 * mapping) are proven through `pairing.test.ts`, which drives this same
 * adapter for every R2 acceptance row. Only a request held open proves the
 * timeout and the caller's abort end the wait, so those two live here.
 */

const ORIGIN = "https://kin.example.com";
const TOKEN = "fixture-token-not-real";

/** A host that accepts the connection and never answers until aborted. */
function hangingFetch() {
  return jest.fn(
    (_input: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      }),
  );
}

describe("KIN-MOBILE-001 R2 transport bounds", () => {
  it("KIN-MOBILE-001 R2: a request that outlives its timeout reads as unreachable", async () => {
    const impl = hangingFetch();

    const result = await apiFetch<unknown>(ORIGIN, listTasksPath(), {
      token: TOKEN,
      fetchImpl: impl as unknown as typeof fetch,
      timeoutMs: 20,
    });

    expect(result).toEqual({ ok: false, status: null, reason: "unreachable" });
    const init = (impl.mock.calls[0] as [string, RequestInit])[1];
    expect(init.signal?.aborted).toBe(true);
  });

  it("KIN-MOBILE-001 R2: an outer abort cancels the request and reads as unreachable", async () => {
    const controller = new AbortController();
    const impl = hangingFetch();

    const pending = apiFetch<unknown>(ORIGIN, listTasksPath(), {
      token: TOKEN,
      fetchImpl: impl as unknown as typeof fetch,
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).resolves.toEqual({
      ok: false,
      status: null,
      reason: "unreachable",
    });
  });
});

/**
 * The status mapping and header rules R2a proved only indirectly through
 * `pairing.test.ts`. Restored here so a change to the adapter fails on the
 * adapter's own test, not in a pairing scenario several calls away.
 */
describe("KIN-MOBILE-001 R2 transport contract", () => {
  function response(status: number): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({}),
    } as unknown as Response;
  }

  function recordingFetch(status = 200) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = jest.fn(async (input: string, init?: RequestInit) => {
      calls.push({ url: input, init: init ?? {} });
      return response(status);
    });
    return { impl: impl as unknown as typeof fetch, calls };
  }

  function header(
    call: { init: RequestInit },
    name: string,
  ): string | undefined {
    return (call.init.headers as Record<string, string> | undefined)?.[name];
  }

  it.each([400, 404, 422])(
    "KIN-MOBILE-001 R2: a %i reads as rejected",
    async (status) => {
      const { impl } = recordingFetch(status);

      const result = await apiFetch<unknown>(ORIGIN, listTasksPath(), {
        fetchImpl: impl,
      });

      expect(result).toEqual({ ok: false, status, reason: "rejected" });
    },
  );

  it("KIN-MOBILE-001 R2: a 503 reads as unreachable", async () => {
    const { impl } = recordingFetch(503);

    const result = await apiFetch<unknown>(ORIGIN, listTasksPath(), {
      fetchImpl: impl,
    });

    expect(result).toEqual({ ok: false, status: 503, reason: "unreachable" });
  });

  it("KIN-MOBILE-001 R2: builds the absolute URL from the origin and always accepts JSON", async () => {
    const { impl, calls } = recordingFetch();

    await apiFetch<unknown>(`${ORIGIN}/`, listTasksPath(), {
      fetchImpl: impl,
      headers: { "X-Test": "1" },
    });

    expect(calls[0].url).toBe(`${ORIGIN}/api/tasks?page=1&limit=20`);
    expect(header(calls[0], "Accept")).toBe("application/json");
    expect(header(calls[0], "X-Test")).toBe("1");
  });

  it("KIN-MOBILE-001 R2: sends a bearer only when a session exists, never a token in the query", async () => {
    const authed = recordingFetch();
    await apiFetch<unknown>(ORIGIN, listTasksPath(), {
      token: TOKEN,
      fetchImpl: authed.impl,
    });

    expect(header(authed.calls[0], "Authorization")).toBe(`Bearer ${TOKEN}`);
    expect(authed.calls[0].url).not.toContain("token=");
    expect(authed.calls[0].url).not.toContain(TOKEN);

    const anonymous = recordingFetch();
    await apiFetch<unknown>(ORIGIN, listTasksPath(), {
      fetchImpl: anonymous.impl,
    });

    expect(header(anonymous.calls[0], "Authorization")).toBeUndefined();
  });

  it("KIN-MOBILE-001 R2: the projects read asks the endpoint the console asks", () => {
    // The phone learns a project's name from the same records the web console
    // reads; the list controller's fourth read depends on this exact path, and
    // `holderOnly` on the server lets a paired device token read it.
    expect(listProjectsPath).toBe("/api/projects");
  });
});
