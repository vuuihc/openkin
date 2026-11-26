import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type { Task } from "@ui/api/contract";
import { redactToken } from "./pairingLink";
import { createPairing } from "./pairing";
import { SESSION_KEY, type SecureBackend } from "./tokenStore";

/**
 * KIN-MOBILE-001 R2 — pairing and the first list read.
 *
 * These are the four acceptance rows from the signed story, plus the retry
 * path for a node that cannot be reached. The auth core returns stable reason
 * codes only; R2b owns the sentences that map them.
 */

const ORIGIN = "https://kin.example.com";
const TOKEN = "fixture-token-not-real";
const LINK = `${ORIGIN}/?token=${TOKEN}`;
const SECRET = "one-time-secret-not-real";
const QR_LINK = `${ORIGIN}/?token=${SECRET}&pairing=1`;
const DEVICE_TOKEN = "device-token-not-real";

const TASKS = [
  { id: "task-1", title: "Fixture conversation" },
  { id: "task-2", title: "Second fixture" },
] as unknown as Task[];

type Call = { url: string; init: RequestInit };

/** A stand-in for the one `expo-secure-store` entry. */
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
  reply: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  const calls: Call[] = [];
  const spy = jest.fn(async (input: string, init?: RequestInit) => {
    const call = { url: input, init: init ?? {} };
    calls.push(call);
    return reply(input, call.init);
  });
  return { impl: spy as unknown as typeof fetch, calls, spy };
}

type Pending = { url: string; init: RequestInit; resolve: (r: Response) => void };

/**
 * The first `deferredCount` requests stay unanswered until the test resolves
 * them, so two flows can land out of order; later requests answer at once.
 */
function controlledFetch(deferredCount: number, later: () => Response) {
  const pending: Pending[] = [];
  const impl = jest.fn((input: string, init?: RequestInit) => {
    if (pending.length < deferredCount) {
      return new Promise<Response>((resolve) => {
        pending.push({ url: input, init: init ?? {}, resolve });
      });
    }
    return Promise.resolve(later());
  });
  return { impl: impl as unknown as typeof fetch, pending };
}

function header(call: Call, name: string): string | undefined {
  return (call.init.headers as Record<string, string> | undefined)?.[name];
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("KIN-MOBILE-001 R2 pairing", () => {
  it("KIN-MOBILE-001 R2: no stored session starts on the pairing entry, not the list", async () => {
    const store = memoryStore();
    const { impl, spy } = recordingFetch(() => response(200, TASKS));
    const pairing = createPairing({ store, fetchImpl: impl });

    const resumed = await pairing.resume();
    const started = await pairing.startRoute();

    expect(resumed.route).toBe("pairing");
    expect(resumed.reason).toBe("none");
    expect(started.route).toBe("pairing");
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    ["a link with no token", `${ORIGIN}/`, "no-token"],
    ["an empty token", `${ORIGIN}/?token=`, "empty-token"],
    ["an ftp link", `ftp://kin.example.com/?token=${TOKEN}`, "bad-link"],
    ["plain text", "not a link at all", "bad-link"],
  ] as const)(
    "KIN-MOBILE-001 R2: refuses %s without a request or a stored session",
    async (_label, raw, _reason) => {
      const store = memoryStore();
      const { impl, spy } = recordingFetch(() => response(200, TASKS));
      const pairing = createPairing({ store, fetchImpl: impl });

      const state = await pairing.pairWithLink(raw);

      // The parser rejects the link before anything is stored or sent.
      expect(state.route).toBe("pairing");
      expect(state.reason).toBe("rejected");
      expect(store.entries.get(SESSION_KEY)).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
    },
  );

  it("KIN-MOBILE-001 R2: a valid link stores the session and the first list read returns the tasks", async () => {
    const store = memoryStore();
    const { impl, calls } = recordingFetch(() => response(200, TASKS));
    const pairing = createPairing({ store, fetchImpl: impl });

    const paired = await pairing.pairWithLink(LINK);

    expect(paired.route).toBe("list");
    expect(paired.tasks).toEqual(TASKS);
    // One Keychain entry holds the origin and the token together.
    expect(JSON.parse(store.entries.get(SESSION_KEY) ?? "null")).toEqual({
      kind: "node",
      origin: ORIGIN,
      token: TOKEN,
    });
    expect(calls[0].url).toBe(`${ORIGIN}/api/tasks?page=1&limit=20`);
    expect(header(calls[0], "Authorization")).toBe(`Bearer ${TOKEN}`);

    const started = await pairing.startRoute();
    expect(started.route).toBe("list");
    expect(started.tasks).toEqual(TASKS);
  });

  it("KIN-MOBILE-001 R2: a 401 marks the stored session expired and is not retried on resume", async () => {
    const store = memoryStore();
    const { impl, spy } = recordingFetch(() => response(401, { error: "unauthorized" }));
    const pairing = createPairing({ store, fetchImpl: impl });

    const paired = await pairing.pairWithLink(LINK);

    expect(paired.route).toBe("pairing");
    expect(paired.reason).toBe("expired");
    expect(store.entries.get(SESSION_KEY)).toBeUndefined();

    const resumed = await pairing.resume();

    expect(resumed.route).toBe("pairing");
    expect(resumed.reason).toBe("expired");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("KIN-MOBILE-001 R2: a 401 on resume retires the stored session and is not retried", async () => {
    const store = memoryStore();
    await store.setItemAsync(
      SESSION_KEY,
      JSON.stringify({ origin: ORIGIN, token: TOKEN }),
    );
    const { impl, spy } = recordingFetch(() => response(401, { error: "unauthorized" }));
    const pairing = createPairing({ store, fetchImpl: impl });

    const resumed = await pairing.resume();

    expect(resumed.route).toBe("pairing");
    expect(resumed.reason).toBe("expired");
    expect(store.entries.get(SESSION_KEY)).toBeUndefined();

    const again = await pairing.resume();

    expect(again.route).toBe("pairing");
    expect(again.reason).toBe("expired");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  const unreachableReplies: Array<[string, () => Response]> = [
    ["a 500", () => response(500, { error: "boom" })],
    [
      "a network failure",
      () => {
        throw new TypeError("Network request failed");
      },
    ],
  ];

  it.each(unreachableReplies)(
    "KIN-MOBILE-001 R2: a stored session survives %s on resume",
    async (_label, reply) => {
      const store = memoryStore();
      await store.setItemAsync(
        SESSION_KEY,
        JSON.stringify({ origin: ORIGIN, token: TOKEN }),
      );
      const { impl } = recordingFetch(reply);
      const pairing = createPairing({ store, fetchImpl: impl });

      const resumed = await pairing.resume();

      // The node is silent, not the token: stay on the list and keep the entry.
      expect(resumed.route).toBe("list");
      expect(resumed.reason).toBe("unreachable");
      expect(JSON.parse(store.entries.get(SESSION_KEY) ?? "null")).toEqual({
        kind: "node",
        origin: ORIGIN,
        token: TOKEN,
      });
    },
  );

  it("KIN-MOBILE-001 R2: a ?pairing=1 secret is exchanged for a device token before the list read", async () => {
    const store = memoryStore();
    const { impl, calls } = recordingFetch((url) =>
      url.endsWith("/api/pairing/exchange")
        ? response(200, { token: DEVICE_TOKEN })
        : response(200, TASKS),
    );
    const pairing = createPairing({ store, fetchImpl: impl });

    const paired = await pairing.pairWithLink(QR_LINK);

    expect(calls[0].url).toBe(`${ORIGIN}/api/pairing/exchange`);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ secret: SECRET });
    // The one-time secret is never sent as a bearer token.
    expect(header(calls[0], "Authorization")).toBeUndefined();

    expect(calls[1].url).toBe(`${ORIGIN}/api/tasks?page=1&limit=20`);
    expect(header(calls[1], "Authorization")).toBe(`Bearer ${DEVICE_TOKEN}`);

    expect(paired.route).toBe("list");
    expect(paired.reason).toBe("none");
    expect(paired.tasks).toEqual(TASKS);
    expect(JSON.parse(store.entries.get(SESSION_KEY) ?? "null")).toEqual({
      kind: "node",
      origin: ORIGIN,
      token: DEVICE_TOKEN,
    });
  });

  it("KIN-MOBILE-001 R2: a consumed secret is recovered with the recovery header", async () => {
    const store = memoryStore();
    const { impl, calls } = recordingFetch((url, init) => {
      if (!url.endsWith("/api/pairing/exchange")) return response(200, TASKS);
      const headers = init.headers as Record<string, string>;
      return headers["X-Kin-Pairing-Recovery"] === "1"
        ? response(200, { token: DEVICE_TOKEN })
        : response(401, { error: "pairing secret already used" });
    });
    const pairing = createPairing({ store, fetchImpl: impl });

    const paired = await pairing.pairWithLink(QR_LINK);

    expect(calls).toHaveLength(3);
    expect(header(calls[0], "X-Kin-Pairing-Recovery")).toBeUndefined();
    expect(header(calls[1], "X-Kin-Pairing-Recovery")).toBe("1");
    expect(header(calls[2], "Authorization")).toBe(`Bearer ${DEVICE_TOKEN}`);
    expect(paired.route).toBe("list");
    expect(JSON.parse(store.entries.get(SESSION_KEY) ?? "null")).toEqual({
      kind: "node",
      origin: ORIGIN,
      token: DEVICE_TOKEN,
    });
  });

  it("KIN-MOBILE-001 R2: a refused exchange keeps the owner on pairing and writes nothing", async () => {
    const store = memoryStore();
    const { impl } = recordingFetch(() =>
      response(401, { error: "pairing secret invalid" }),
    );
    const pairing = createPairing({ store, fetchImpl: impl });

    const paired = await pairing.pairWithLink(QR_LINK);

    expect(paired.route).toBe("pairing");
    expect(paired.reason).toBe("expired");
    expect(paired.origin).toBe(ORIGIN);
    expect(store.entries.get(SESSION_KEY)).toBeUndefined();
  });

  it("KIN-MOBILE-001 R2: a late 401 from a superseded pairing does not retire the newer session", async () => {
    const store = memoryStore();
    const { impl, pending } = controlledFetch(2, () => response(200, TASKS));
    const pairing = createPairing({ store, fetchImpl: impl });

    const superseded = pairing.pairWithLink(
      `https://old.example.com/?token=old-token`,
    );
    const latest = pairing.pairWithLink(LINK);
    expect(pending).toHaveLength(2);

    pending[1].resolve(response(200, TASKS));
    const paired = await latest;
    expect(paired.route).toBe("list");
    expect(JSON.parse(store.entries.get(SESSION_KEY) ?? "null")).toEqual({
      kind: "node",
      origin: ORIGIN,
      token: TOKEN,
    });

    // The older call's answer lands last: it must not clear or overwrite the
    // newer session, and it must not flash a retired pairing state.
    pending[0].resolve(response(401, { error: "unauthorized" }));
    const stale = await superseded;

    expect(stale.route).toBe("list");
    expect(stale.reason).toBe("none");
    expect(stale.tasks).toEqual(TASKS);
    expect(JSON.parse(store.entries.get(SESSION_KEY) ?? "null")).toEqual({
      kind: "node",
      origin: ORIGIN,
      token: TOKEN,
    });

    // A real boot still reads the newer session instead of reporting expired.
    const resumed = await pairing.resume();
    expect(resumed.route).toBe("list");
    expect(resumed.reason).toBe("none");
  });

  it("KIN-MOBILE-001 R2: the token never appears in the URL, the result, or a log line", async () => {
    const logged: string[] = [];
    const record = (...parts: unknown[]): void => {
      logged.push(parts.map((part) => String(part)).join(" "));
    };
    jest.spyOn(console, "log").mockImplementation(record);
    jest.spyOn(console, "info").mockImplementation(record);
    jest.spyOn(console, "warn").mockImplementation(record);
    jest.spyOn(console, "error").mockImplementation(record);

    const store = memoryStore();
    const { impl, calls } = recordingFetch(() => response(200, TASKS));
    const pairing = createPairing({ store, fetchImpl: impl });

    const state = await pairing.pairWithLink(LINK);

    expect(Object.keys(state)).not.toContain("token");
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect(redactToken(LINK)).toBe(ORIGIN);
    expect(redactToken(LINK)).not.toContain(TOKEN);
    expect(calls[0].url).not.toContain("token=");
    expect(calls[0].url).not.toContain(TOKEN);
    expect(logged.join("\n")).not.toContain(TOKEN);
  });

  it("KIN-MOBILE-001 R2: an unreachable node keeps the typed link usable for a retry", async () => {
    const store = memoryStore();
    const { impl, calls } = recordingFetch(() => {
      throw new TypeError("Network request failed");
    });
    const pairing = createPairing({ store, fetchImpl: impl });

    const first = await pairing.pairWithLink(LINK);

    expect(first.route).toBe("pairing");
    expect(first.reason).toBe("unreachable");
    expect(first.origin).toBe(ORIGIN);
    expect(first.display).toBe(ORIGIN);
    // An unproven token is not written to the Keychain.
    expect(store.entries.get(SESSION_KEY)).toBeUndefined();

    const retried = await pairing.pairWithLink(LINK);

    expect(retried.reason).toBe("unreachable");
    expect(calls).toHaveLength(2);
  });
});

describe("R-rn-hub-signin hub expiry", () => {
  it("R-rn-hub-signin: a 401 on a Hub read retires the session and keeps the origin", async () => {
    const store = memoryStore();
    store.entries.set(
      SESSION_KEY,
      JSON.stringify({ kind: "hub", origin: ORIGIN }),
    );
    const fetch = recordingFetch(() => response(401, {}));
    const core = createPairing({ store, fetchImpl: fetch.impl });

    const next = await core.resume();

    expect(next.route).toBe("pairing");
    expect(next.reason).toBe("expired");
    expect(next.origin).toBe(ORIGIN);
    expect(store.entries.has(SESSION_KEY)).toBe(false);
    // The read carried the cookie, never a bearer.
    const headers = fetch.calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
    expect(fetch.calls[0].init.credentials).toBe("include");
  });
});
