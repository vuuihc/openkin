// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PushPermissionError,
  PushUnsubscribeError,
  applicationServerKey,
  currentPushSubscription,
  disablePush,
  enablePush,
  pushPermission,
  pushSupported,
  serializeSubscription,
} from "./push";

/**
 * The browser half of push. What is pinned here is the conversion the daemon's
 * key travels through and the two calls that have browser-visible side
 * effects: a wrong key produces an opaque InvalidStateError, and subscribing
 * without a gesture gets the permission denied for good.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  // @ts-expect-error -- the tests install these; removing them restores jsdom.
  delete navigator.serviceWorker;
  // @ts-expect-error -- same.
  delete window.PushManager;
});

function installBrowser(options: {
  permission?: NotificationPermission;
  existing?: { endpoint: string; unsubscribe: () => Promise<boolean> } | null;
}) {
  vi.stubGlobal("PushManager", function PushManager() {});
  const subscribe = vi.fn(async () => ({
    endpoint: "https://push.example.net/new",
    toJSON: () => ({
      endpoint: "https://push.example.net/new",
      keys: { p256dh: "pkey", auth: "asecret" },
    }),
  }));
  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => options.existing ?? null),
      subscribe,
    },
  };
  const ready = Promise.resolve(registration);
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: vi.fn(async () => registration),
      getRegistration: vi.fn(async () => registration),
      ready,
    },
  });
  vi.stubGlobal("Notification", {
    permission: options.permission ?? "default",
    requestPermission: vi.fn(async () => options.permission ?? "granted"),
  });
  return { registration, subscribe };
}

describe("applicationServerKey", () => {
  it("decodes unpadded base64url", () => {
    // `-_8` is the URL-safe spelling of `+/8`; both are two bytes.
    expect(Array.from(applicationServerKey("-_8"))).toEqual([0xfb, 0xff]);
  });

  it("decodes a padded standard key too", () => {
    expect(Array.from(applicationServerKey("AQID"))).toEqual([1, 2, 3]);
  });

  it("returns the 65 bytes of a P-256 point", () => {
    const key = new Uint8Array(65);
    key[0] = 0x04;
    const encoded = btoa(String.fromCharCode(...key))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const decoded = applicationServerKey(encoded);
    expect(decoded).toHaveLength(65);
    expect(decoded[0]).toBe(0x04);
  });
});

describe("serializeSubscription", () => {
  it("carries the endpoint and both keys", () => {
    const body = serializeSubscription({
      endpoint: "https://push.example.net/a",
      toJSON: () => ({
        endpoint: "https://push.example.net/a",
        keys: { p256dh: "p", auth: "a" },
      }),
    } as unknown as PushSubscription);
    expect(body).toEqual({
      endpoint: "https://push.example.net/a",
      keys: { p256dh: "p", auth: "a" },
    });
  });

  it("refuses a subscription the browser did not fully describe", () => {
    const body = serializeSubscription({
      endpoint: "https://push.example.net/a",
      toJSON: () => ({ endpoint: "https://push.example.net/a", keys: {} }),
    } as unknown as PushSubscription);
    expect(body).toBeNull();
  });
});

describe("enablePush", () => {
  it("asks for permission, registers the worker and subscribes", async () => {
    const { subscribe } = installBrowser({ permission: "granted" });
    const sub = await enablePush("AQID");
    expect(sub.endpoint).toBe("https://push.example.net/new");
    expect(navigator.serviceWorker.register).toHaveBeenCalledWith("/sw.js", { scope: "/" });
    expect(subscribe).toHaveBeenCalledTimes(1);
    const arg = (subscribe.mock.calls[0] as unknown[])[0] as {
      userVisibleOnly: boolean;
      applicationServerKey: Uint8Array;
    };
    expect(arg.userVisibleOnly).toBe(true);
    expect(Array.from(arg.applicationServerKey)).toEqual([1, 2, 3]);
  });

  it("does not subscribe when the reader declines", async () => {
    const { subscribe } = installBrowser({ permission: "denied" });
    await expect(enablePush("AQID")).rejects.toBeInstanceOf(PushPermissionError);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("reuses a subscription made with the same key", async () => {
    const existing = {
      endpoint: "https://push.example.net/old",
      options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
      unsubscribe: vi.fn(async () => true),
    };
    const { subscribe } = installBrowser({
      permission: "granted",
      existing: existing as never,
    });
    const sub = await enablePush("AQID");
    expect(sub.endpoint).toBe("https://push.example.net/old");
    expect(subscribe).not.toHaveBeenCalled();
    expect(existing.unsubscribe).not.toHaveBeenCalled();
  });

  it("replaces a subscription made with a key the daemon no longer has", async () => {
    // A restored database mints a new VAPID pair; the old subscription is
    // bound to the old one and every message to it would be refused.
    const existing = {
      endpoint: "https://push.example.net/old",
      options: { applicationServerKey: new Uint8Array([9, 9, 9]).buffer },
      unsubscribe: vi.fn(async () => true),
    };
    const { subscribe } = installBrowser({
      permission: "granted",
      existing: existing as never,
    });
    const sub = await enablePush("AQID");
    expect(existing.unsubscribe).toHaveBeenCalledTimes(1);
    expect(sub.endpoint).toBe("https://push.example.net/new");
    expect(subscribe).toHaveBeenCalledTimes(1);
  });
});

describe("disablePush", () => {
  it("unsubscribes and returns the endpoint the daemon must forget", async () => {
    const unsubscribe = vi.fn(async () => true);
    installBrowser({
      permission: "granted",
      existing: { endpoint: "https://push.example.net/old", unsubscribe } as never,
    });
    await expect(disablePush()).resolves.toBe("https://push.example.net/old");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("reports a failure instead of claiming off when the browser keeps it", async () => {
    // `unsubscribe()` resolves false when the push service could not be told.
    // Returning the endpoint anyway would delete the daemon row and leave a
    // browser that still rings, with the settings page saying otherwise.
    const unsubscribe = vi.fn(async () => false);
    installBrowser({
      permission: "granted",
      existing: { endpoint: "https://push.example.net/old", unsubscribe } as never,
    });
    await expect(disablePush()).rejects.toBeInstanceOf(PushUnsubscribeError);
  });
});

describe("capability detection", () => {
  it("is unsupported when the browser has no push manager", () => {
    expect(pushSupported()).toBe(false);
  });

  it("is supported once the APIs exist", () => {
    installBrowser({});
    expect(pushSupported()).toBe(true);
  });

  it("reports the permission without prompting", () => {
    installBrowser({ permission: "granted" });
    expect(pushPermission()).toBe("granted");
    expect(Notification.requestPermission).not.toHaveBeenCalled();
  });

  it("has no subscription when no worker is registered", async () => {
    expect(await currentPushSubscription()).toBeNull();
  });
});
