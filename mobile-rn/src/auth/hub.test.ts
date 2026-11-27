import { describe, expect, it, jest } from "@jest/globals";
import {
  createHubSignIn,
  normalizeHubOrigin,
  parseHubConnectLink,
} from "./hub";
import { SESSION_KEY, type SecureBackend } from "./tokenStore";

/**
 * R-rn-hub-signin — signing in to a Hub.
 *
 * The reason codes, the write-after-proof rule, and the plaintext refusal that
 * happens before any request. Success is only ever `{kind: "hub"}` in the
 * Keychain: the cookie is the credential and never passes through this module.
 * Provider sign-in (the system-browser flow) is the next slice.
 */

const HUB = "https://h.example";
const EMAIL = "owner@example.com";

type Call = { url: string; init: RequestInit; path: string; body: unknown };

function memoryStore(): SecureBackend & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItemAsync: async (key) => entries.get(key) ?? null,
    setItemAsync: async (key, value) => {
      entries.set(key, value);
    },
    deleteItemAsync: async (key) => {
      entries.delete(key);
    },
  };
}

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  } as unknown as Response;
}

function recordingFetch(
  reply: (path: string, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  const impl = jest.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    const call: Call = {
      url: input,
      path,
      init: init ?? {},
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return reply(path, call.init);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function hubSignIn(
  reply: (path: string, init: RequestInit) => Response | Promise<Response>,
) {
  const store = memoryStore();
  const fetch = recordingFetch(reply);
  const signIn = createHubSignIn({ store, fetchImpl: fetch.impl });
  return { store, fetch, signIn };
}

describe("R-rn-hub-signin Hub URL", () => {
  it("R-rn-hub-signin: a Hub is https, or http only on loopback", () => {
    expect(normalizeHubOrigin("https://h.example")).toBe(HUB);
    expect(normalizeHubOrigin("h.example")).toBe(HUB);
    expect(normalizeHubOrigin(" https://h.example/some/path ")).toBe(HUB);
    expect(normalizeHubOrigin("http://h.example")).toBeNull();
    expect(normalizeHubOrigin("http://127.0.0.1:7777")).toBe(
      "http://127.0.0.1:7777",
    );
    expect(normalizeHubOrigin("javascript:alert(1)")).toBeNull();
    expect(normalizeHubOrigin("")).toBeNull();
  });

  it("R-rn-hub-signin: the opt-in is the one way to admit a plaintext Hub off loopback", () => {
    const plain = "http://192.168.1.42:7777";

    // Default deny is unchanged: every caller that omits the opt-in refuses.
    expect(normalizeHubOrigin(plain)).toBeNull();
    expect(normalizeHubOrigin(plain, { allowInsecure: false })).toBeNull();
    // The explicit opt-in admits exactly that origin, unchanged.
    expect(normalizeHubOrigin(plain, { allowInsecure: true })).toBe(plain);

    // https and loopback http keep working with or without it.
    expect(normalizeHubOrigin(HUB)).toBe(HUB);
    expect(normalizeHubOrigin(HUB, { allowInsecure: true })).toBe(HUB);
    expect(normalizeHubOrigin("http://127.0.0.1:7777")).toBe(
      "http://127.0.0.1:7777",
    );

    // A link only pre-fills the screen; it can never supply the opt-in.
    expect(parseHubConnectLink(`kin://connect?hub=${plain}`)).toBeNull();
  });

  it("R-rn-hub-signin: a kin://connect link pre-fills its Hub", () => {
    expect(parseHubConnectLink(`kin://connect?hub=${HUB}`)).toBe(HUB);
    expect(parseHubConnectLink(`kin://connect?url=${HUB}`)).toBe(HUB);
    expect(parseHubConnectLink("kin://connect?hub=http://h.example")).toBeNull();
    expect(parseHubConnectLink(`https://h.example/connect?hub=${HUB}`)).toBeNull();
    expect(parseHubConnectLink("kin://auth-callback?code=x")).toBeNull();
  });
});

describe("R-rn-hub-signin password sign-in", () => {
  it("R-rn-hub-signin: writes the Hub only after /api/auth/me answers 200", async () => {
    const { store, fetch, signIn } = hubSignIn((path) => {
      if (path === "/api/auth/login") return response(200, {});
      if (path === "/api/auth/me") return response(200, { user: { email: EMAIL } });
      return response(404, {});
    });

    const result = await signIn.signInWithPassword(HUB, EMAIL, "fixture-password");

    expect(result).toEqual({ ok: true, origin: HUB });
    expect(fetch.calls.map((call) => call.path)).toEqual([
      "/api/auth/login",
      "/api/auth/me",
    ]);
    expect(fetch.calls[0].body).toEqual({
      email: EMAIL,
      password: "fixture-password",
    });
    expect(fetch.calls[0].init.credentials).toBe("include");
    expect(JSON.parse(store.entries.get(SESSION_KEY) ?? "")).toEqual({
      kind: "hub",
      origin: HUB,
    });
  });

  it("R-rn-hub-signin: a 401 from /api/auth/login writes nothing and reads as rejected", async () => {
    const { store, fetch, signIn } = hubSignIn(() => response(401, {}));

    const result = await signIn.signInWithPassword(HUB, EMAIL, "wrong");

    expect(result).toEqual({ ok: false, reason: "rejected", origin: HUB });
    expect(fetch.calls.map((call) => call.path)).toEqual(["/api/auth/login"]);
    expect(store.entries.has(SESSION_KEY)).toBe(false);
  });

  it("R-rn-hub-signin: a wrong password carries the server's refusal code", async () => {
    const { store, signIn } = hubSignIn(() =>
      response(401, {
        error: "email or password is incorrect",
        code: "invalid_credentials",
      }),
    );

    const result = await signIn.signInWithPassword(HUB, EMAIL, "wrong");

    expect(result).toEqual({
      ok: false,
      reason: "rejected",
      origin: HUB,
      errorCode: "invalid_credentials",
    });
    expect(store.entries.has(SESSION_KEY)).toBe(false);
  });

  it("R-rn-hub-signin: a login that passes but /me refuses writes nothing", async () => {
    const { store, signIn } = hubSignIn((path) =>
      path === "/api/auth/login" ? response(200, {}) : response(401, {}),
    );

    const result = await signIn.signInWithPassword(HUB, EMAIL, "fixture-password");

    expect(result).toEqual({ ok: false, reason: "rejected", origin: HUB });
    expect(store.entries.has(SESSION_KEY)).toBe(false);
  });

  it("R-rn-hub-signin: a network failure reads as unreachable", async () => {
    const { store, signIn } = hubSignIn(() => {
      throw new TypeError("Network request failed");
    });

    const result = await signIn.signInWithPassword(HUB, EMAIL, "fixture-password");

    expect(result).toEqual({ ok: false, reason: "unreachable", origin: HUB });
    expect(store.entries.has(SESSION_KEY)).toBe(false);
  });

  it("R-rn-hub-signin: an http Hub off loopback is refused before any request", async () => {
    const { fetch, signIn } = hubSignIn(() => response(200, {}));

    const result = await signIn.signInWithPassword(
      "http://h.example",
      EMAIL,
      "fixture-password",
    );

    expect(result).toEqual({ ok: false, reason: "insecure", origin: null });
    expect(fetch.calls).toHaveLength(0);
  });

  it("R-rn-hub-signin: the plaintext allowance is per call and never remembered", async () => {
    const { fetch, signIn } = hubSignIn((path) =>
      path === "/api/auth/status"
        ? response(200, { providers: [] })
        : response(200, {}),
    );
    const plain = "http://192.168.1.42:7777";

    const allowed = await signIn.probe(plain, { allowInsecure: true });
    expect(allowed).toMatchObject({ ok: true, origin: plain });
    expect(fetch.calls.map((call) => call.path)).toEqual(["/api/auth/status"]);

    // The next call that omits the opt-in is refused again, before any
    // request: the allowance belongs to one call, not to the module.
    await expect(signIn.probe(plain)).resolves.toEqual({
      ok: false,
      reason: "insecure",
      origin: null,
    });
    await expect(
      signIn.signInWithPassword(plain, EMAIL, "fixture-password"),
    ).resolves.toEqual({ ok: false, reason: "insecure", origin: null });
    expect(fetch.calls).toHaveLength(1);
  });
});

describe("R-rn-hub-signin sign out", () => {
  it("R-rn-hub-signin: logout is best effort and the Keychain entry still goes", async () => {
    const { store, fetch, signIn } = hubSignIn(() => {
      throw new TypeError("offline");
    });
    store.entries.set(SESSION_KEY, JSON.stringify({ kind: "hub", origin: HUB }));

    await signIn.signOut(HUB);

    expect(fetch.calls.map((call) => call.path)).toEqual(["/api/auth/logout"]);
    expect(store.entries.has(SESSION_KEY)).toBe(false);
  });

  it("R-rn-hub-signin: signing out of a plaintext Hub still reaches it", async () => {
    const plain = "http://192.168.1.42:7777";
    const { store, fetch, signIn } = hubSignIn(() => response(200, {}));
    store.entries.set(
      SESSION_KEY,
      JSON.stringify({ kind: "hub", origin: plain, insecure: true }),
    );

    await signIn.signOut(plain);

    // Sign-out is the safe direction, so the confirmed origin keeps its
    // best-effort logout instead of being refused as insecure.
    expect(fetch.calls.map((call) => call.path)).toEqual(["/api/auth/logout"]);
    expect(store.entries.has(SESSION_KEY)).toBe(false);
  });
});
