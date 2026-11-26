import { describe, expect, it } from "@jest/globals";
import {
  SESSION_KEY,
  readSession,
  writeSession,
  type SecureBackend,
} from "./tokenStore";

/**
 * R-rn-hub-signin — the one Keychain entry now holds either a node pairing or
 * a Hub sign-in.
 *
 * The installed app wrote `{origin, token}` before this change, so an entry
 * without `kind` must keep reading as a node session. A Hub session has no
 * secret in the Keychain: its credential is the native cookie jar.
 */

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

const ORIGIN = "https://kin.example.com";

describe("R-rn-hub-signin token store", () => {
  it("R-rn-hub-signin: an entry written before the union reads as a node session", async () => {
    const store = memoryStore();
    store.entries.set(
      SESSION_KEY,
      JSON.stringify({ origin: ORIGIN, token: "fixture-token-not-real" }),
    );

    await expect(readSession(store)).resolves.toEqual({
      kind: "node",
      origin: ORIGIN,
      token: "fixture-token-not-real",
    });
  });

  it("R-rn-hub-signin: a hub session round-trips with no token field", async () => {
    const store = memoryStore();

    await writeSession({ kind: "hub", origin: ORIGIN }, store);

    const raw = store.entries.get(SESSION_KEY) ?? "";
    expect(JSON.parse(raw)).toEqual({ kind: "hub", origin: ORIGIN });
    expect(raw).not.toContain("token");
    await expect(readSession(store)).resolves.toEqual({
      kind: "hub",
      origin: ORIGIN,
    });
  });

  it("R-rn-hub-signin: a malformed entry reads as no session", async () => {
    const store = memoryStore();

    for (const raw of [
      "{not json",
      JSON.stringify({ kind: "hub" }),
      JSON.stringify({ kind: "hub", origin: "http://kin.example.com" }),
      JSON.stringify({ kind: "node", origin: ORIGIN }),
      JSON.stringify({ kind: "node", origin: ORIGIN, token: "   " }),
      JSON.stringify({ kind: "elsewhere", origin: ORIGIN, token: "x" }),
    ]) {
      store.entries.set(SESSION_KEY, raw);
      await expect(readSession(store)).resolves.toBeNull();
    }
  });
});
