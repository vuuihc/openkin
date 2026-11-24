import { describe, expect, it, jest } from "@jest/globals";
import { apiFetch, listTasksPath } from "./transport";

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
