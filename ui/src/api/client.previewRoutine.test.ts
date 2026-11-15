import { afterEach, describe, expect, it, vi } from "vitest";
import { previewRoutine } from "./client";

/**
 * The form's next-run line comes from the daemon, so the request that asks for
 * it is part of the contract: the rule travels as the exact string create
 * would store, and the answer is the daemon's own numbers. A source pin on the
 * page cannot prove either.
 */
type Call = { url: string; init: RequestInit | undefined };

function stubPreview(body: string): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("previewRoutine", () => {
  it("posts the rule to the preview endpoint and returns the daemon's answer", async () => {
    const calls = stubPreview('{"next_due_at":1800000000000}');
    const answer = await previewRoutine('{"kind":"daily","hour":9,"minute":30}');
    expect(new URL(calls[0].url, "http://kin.example.com").pathname).toBe("/api/routines/preview");
    expect(calls[0].init?.method).toBe("POST");
    // The rule string is passed through verbatim: re-encoding it here would
    // let the preview answer for a rule the save path never sends.
    expect(calls[0].init?.body).toBe(
      '{"recurrence":"{\\"kind\\":\\"daily\\",\\"hour\\":9,\\"minute\\":30}"}',
    );
    expect(answer).toEqual({ next_due_at: 1800000000000 });
  });
});
