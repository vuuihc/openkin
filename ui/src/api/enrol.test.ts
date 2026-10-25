import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Which route an account is created on, and what the request says.
 *
 * These two functions are one line each and were covered by nothing. The hazard
 * is not the line, it is the pairing: `/api/auth/bootstrap` makes the Hub's
 * *owner* and `/api/auth/join` makes a *member*, so swapping the two paths turns
 * "invite a colleague" into "hand a stranger the machine" — and every other test
 * in the suite stays green, because each path is a valid route to a real screen.
 *
 * The body is asserted for the same reason at a lower stakes: the server rejects
 * unknown fields, so a rename here is a 400 that no other test would attribute
 * to the client.
 *
 * vitest runs here without a DOM, so `fetch`, `window` and `localStorage` are
 * stubbed before the module is imported — the same shape client.session.test.ts
 * uses.
 */
const localStorageStub = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
vi.stubGlobal("localStorage", localStorageStub);
vi.stubGlobal("window", {
  location: { search: "", href: "https://kin.example.com/" },
  history: { replaceState: () => {} },
});

type Call = { path: string; method: string; body: Record<string, unknown> };

function stubFetch(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", (input: unknown, init?: RequestInit) => {
    calls.push({
      path: String(input),
      method: String(init?.method ?? "GET"),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ user: { id: "u1", email: "owner@example.com" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  return calls;
}

const { claimOwner, joinHub } = await import("./account");

const INPUT = {
  code: "HZ9EW-V3DPK-4MNQB-7RTXS",
  email: "joiner@example.com",
  password: "hunter2hunter2",
  displayName: "Joiner",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("localStorage", localStorageStub);
  vi.stubGlobal("window", {
    location: { search: "", href: "https://kin.example.com/" },
    history: { replaceState: () => {} },
  });
});

describe("creating an account from a code", () => {
  it("claims the hub on the bootstrap route when the caller is the owner", async () => {
    const calls = stubFetch();

    await claimOwner(INPUT);

    expect(calls.map((c) => [c.method, c.path])).toEqual([["POST", "/api/auth/bootstrap"]]);
  });

  it("joins on the join route when the caller was invited", async () => {
    const calls = stubFetch();

    await joinHub(INPUT);

    expect(calls.map((c) => [c.method, c.path])).toEqual([["POST", "/api/auth/join"]]);
  });

  it("sends the same body on both routes", async () => {
    // The role is the route's decision and is never sent from here. If a `role`
    // key ever appears in this body, the client has started choosing it.
    const claimCalls = stubFetch();
    await claimOwner(INPUT);
    const joinCalls = stubFetch();
    await joinHub(INPUT);

    expect(claimCalls[0].body).toEqual(joinCalls[0].body);
    expect(joinCalls[0].body).toEqual({
      code: "HZ9EW-V3DPK-4MNQB-7RTXS",
      email: "joiner@example.com",
      password: "hunter2hunter2",
      display_name: "Joiner",
    });
  });

  it("does not carry the display name under its camelCase spelling", async () => {
    // The server decodes with DisallowUnknownFields, so `displayName` is a 400
    // rather than a silently ignored field.
    const calls = stubFetch();

    await joinHub(INPUT);

    expect(calls[0].body).not.toHaveProperty("displayName");
  });
});
