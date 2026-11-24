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

function recordingFetch(reply: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const spy = jest.fn(async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init: init ?? {} });
    return reply(input);
  });
  return { impl: spy as unknown as typeof fetch, calls, spy };
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

  it("KIN-MOBILE-001 R2: a valid link stores the session and the first list read returns the tasks", async () => {
    const store = memoryStore();
    const { impl, calls } = recordingFetch(() => response(200, TASKS));
    const pairing = createPairing({ store, fetchImpl: impl });

    const paired = await pairing.pairWithLink(LINK);

    expect(paired.route).toBe("list");
    expect(paired.tasks).toEqual(TASKS);
    // One Keychain entry holds the origin and the token together.
    expect(JSON.parse(store.entries.get(SESSION_KEY) ?? "null")).toEqual({
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
