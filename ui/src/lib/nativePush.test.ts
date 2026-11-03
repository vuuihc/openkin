// @vitest-environment jsdom
// KIN-NOTIFY-001: the console keeps only the native shell's push contract.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NativePushPermissionError,
  disableNativePush,
  disableNativePushOnSignOut,
  enableNativePush,
  clearDeliveredNotification,
  deliveredNotificationTargets,
  flushPendingNativeDelete,
  forgetNativeDevice,
  forgetPendingNativeDelete,
  nativePushPlugin,
  nativePushSurface,
  pendingNativeDelete,
  pushErrorKey,
  rememberedNativeDevice,
  rememberNativeDevice,
  rememberPendingNativeDelete,
  requestNativePushPermission,
  syncNativePush,
  type NativePushApi,
  type NativePushPlugin,
} from "./nativePush";

/**
 * The native shell is not present in these tests, so the contract is exercised
 * through a fake plugin. What matters here is which side does what: the shell
 * owns permission and the token, the node owns the row, and neither prompt nor
 * request happens on a passive read.
 */

function fakePlugin(overrides: Partial<NativePushPlugin> = {}): NativePushPlugin {
  return {
    permission: vi.fn(async () => ({ status: "granted" as const })),
    requestPermission: vi.fn(async () => ({ status: "granted" as const })),
    register: vi.fn(async () => ({
      installId: "install-0001",
      token: "aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb",
      environment: "sandbox" as const,
      name: "iPhone",
    })),
    unregister: vi.fn(async () => undefined),
    openSettings: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fakeApi(): NativePushApi & {
  registerPushDevice: ReturnType<typeof vi.fn>;
  deletePushDevice: ReturnType<typeof vi.fn>;
} {
  return {
    registerPushDevice: vi.fn(async () => ({ id: "row-1" })),
    deletePushDevice: vi.fn(async () => undefined),
  };
}

function iosScope(plugin: NativePushPlugin) {
  return {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => "ios",
      Plugins: { KinNativePush: plugin },
    },
  };
}

beforeEach(() => {
  forgetNativeDevice();
  forgetPendingNativeDelete();
  vi.clearAllMocks();
});

describe("nativePushSurface", () => {
  it("reports the iOS shell, not a browser, when the plugin is present", () => {
    expect(nativePushSurface(iosScope(fakePlugin()))).toBe("ios");
    expect(nativePushPlugin(iosScope(fakePlugin()))).not.toBeNull();
  });

  it("stays a browser when Capacitor is absent, Android, or the plugin is missing", () => {
    expect(nativePushSurface({})).toBe("browser");
    expect(
      nativePushSurface({
        Capacitor: { isNativePlatform: () => true, getPlatform: () => "android" },
      }),
    ).toBe("browser");
    expect(
      nativePushSurface({
        Capacitor: { isNativePlatform: () => false, getPlatform: () => "ios" },
      }),
    ).toBe("browser");
    expect(
      nativePushSurface({
        Capacitor: {
          isNativePlatform: () => true,
          getPlatform: () => "ios",
          Plugins: { KinNativePush: { permission: () => undefined } },
        },
      }),
    ).toBe("browser");
  });
});

describe("requestNativePushPermission", () => {
  it("asks the system only while the status is still prompt", async () => {
    const first = fakePlugin({ permission: vi.fn(async () => ({ status: "prompt" as const })) });
    expect(await requestNativePushPermission(first)).toBe("granted");
    expect(first.requestPermission).toHaveBeenCalledTimes(1);

    const already = fakePlugin();
    expect(await requestNativePushPermission(already)).toBe("granted");
    expect(already.requestPermission).not.toHaveBeenCalled();
  });

  it("reports a denied prompt as denied", async () => {
    const plugin = fakePlugin({
      permission: vi.fn(async () => ({ status: "prompt" as const })),
      requestPermission: vi.fn(async () => ({ status: "denied" as const })),
    });
    expect(await requestNativePushPermission(plugin)).toBe("denied");
  });
});

describe("enableNativePush", () => {
  it("registers the token with the install id and environment the shell reports", async () => {
    const plugin = fakePlugin({
      permission: vi.fn(async () => ({ status: "prompt" as const })),
    });
    const api = fakeApi();

    const result = await enableNativePush(plugin, api);

    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
    expect(api.registerPushDevice).toHaveBeenCalledWith({
      install_id: "install-0001",
      platform: "ios",
      token: "aabbccdd00112233445566778899aabbccddeeff00112233445566778899aabb",
      environment: "sandbox",
      name: "iPhone",
    });
    expect(result.id).toBe("row-1");
  });

  it("does not register anything when the permission is refused", async () => {
    const plugin = fakePlugin({
      permission: vi.fn(async () => ({ status: "prompt" as const })),
      requestPermission: vi.fn(async () => ({ status: "denied" as const })),
    });
    const api = fakeApi();

    await expect(enableNativePush(plugin, api)).rejects.toBeInstanceOf(NativePushPermissionError);
    expect(plugin.register).not.toHaveBeenCalled();
    expect(api.registerPushDevice).not.toHaveBeenCalled();
  });
});

describe("syncNativePush", () => {
  it("refreshes the row without prompting when the permission is already granted", async () => {
    const plugin = fakePlugin();
    const api = fakeApi();
    const result = await syncNativePush(plugin, api);
    expect(result?.id).toBe("row-1");
    expect(plugin.requestPermission).not.toHaveBeenCalled();
    expect(api.registerPushDevice).toHaveBeenCalledTimes(1);
  });

  it("returns null and does nothing when the permission was revoked", async () => {
    const plugin = fakePlugin({ permission: vi.fn(async () => ({ status: "denied" as const })) });
    const api = fakeApi();
    expect(await syncNativePush(plugin, api)).toBeNull();
    expect(plugin.register).not.toHaveBeenCalled();
    expect(api.registerPushDevice).not.toHaveBeenCalled();
  });
});

describe("disableNativePush", () => {
  it("removes the node row before telling the shell to stop", async () => {
    const order: string[] = [];
    const unregister = vi.fn(async () => {
      order.push("shell");
    });
    const plugin = fakePlugin({ unregister });
    const api = fakeApi();
    api.deletePushDevice.mockImplementation(async () => {
      order.push("node");
    });

    const result = await disableNativePush(plugin, api, "row-1");

    expect(result).toEqual({ pending: false });
    expect(api.deletePushDevice).toHaveBeenCalledWith("row-1");
    expect(order).toEqual(["node", "shell"]);
  });

  it("still stops this phone and remembers the row when the node is unreachable", async () => {
    const plugin = fakePlugin();
    const api = fakeApi();
    api.deletePushDevice.mockRejectedValue(new Error("offline"));

    const result = await disableNativePush(plugin, api, "row-1");

    expect(result).toEqual({ pending: true });
    expect(plugin.unregister).toHaveBeenCalledTimes(1);
    expect(pendingNativeDelete()).toBe("row-1");
  });

  it("treats a 404 as already deleted", async () => {
    const plugin = fakePlugin();
    const api = fakeApi();
    api.deletePushDevice.mockRejectedValue(
      Object.assign(new Error("not found"), { status: 404 }),
    );

    const result = await disableNativePush(plugin, api, "row-1");

    expect(result).toEqual({ pending: false });
    expect(plugin.unregister).toHaveBeenCalledTimes(1);
    expect(pendingNativeDelete()).toBeNull();
  });

  it("does not remember a row this credential may never delete", async () => {
    // 401/403 cannot become deletable by retrying; keeping the id would retry
    // it on every settings load while the shell is already quiet.
    const plugin = fakePlugin();
    const api = fakeApi();
    api.deletePushDevice.mockRejectedValue(
      Object.assign(new Error("forbidden"), { status: 403 }),
    );

    const result = await disableNativePush(plugin, api, "row-1");

    expect(result).toEqual({ pending: false });
    expect(plugin.unregister).toHaveBeenCalledTimes(1);
    expect(pendingNativeDelete()).toBeNull();
  });
});

describe("flushPendingNativeDelete", () => {
  it("finishes the deletion on a later load", async () => {
    rememberPendingNativeDelete("row-1");
    const api = fakeApi();
    expect(await flushPendingNativeDelete(api)).toBe(false);
    expect(api.deletePushDevice).toHaveBeenCalledWith("row-1");
    expect(pendingNativeDelete()).toBeNull();
  });

  it("treats a row that is already gone as finished", async () => {
    rememberPendingNativeDelete("row-1");
    const api = fakeApi();
    api.deletePushDevice.mockRejectedValue(
      Object.assign(new Error("not found"), { status: 404 }),
    );
    expect(await flushPendingNativeDelete(api)).toBe(false);
    expect(pendingNativeDelete()).toBeNull();
  });

  it("drops a row this credential can never delete", async () => {
    // A 401/403 means the row is not this caller's to remove; retrying it on
    // every settings load would never succeed.
    rememberPendingNativeDelete("row-1");
    const api = fakeApi();
    api.deletePushDevice.mockRejectedValue(
      Object.assign(new Error("forbidden"), { status: 403 }),
    );
    expect(await flushPendingNativeDelete(api)).toBe(false);
    expect(pendingNativeDelete()).toBeNull();
  });

  it("keeps the marker while the node is still unreachable", async () => {
    rememberPendingNativeDelete("row-1");
    const api = fakeApi();
    api.deletePushDevice.mockRejectedValue(new Error("offline"));
    expect(await flushPendingNativeDelete(api)).toBe(true);
    expect(pendingNativeDelete()).toBe("row-1");
  });

  it("does nothing when there is no pending deletion", async () => {
    const api = fakeApi();
    expect(await flushPendingNativeDelete(api)).toBe(false);
    expect(api.deletePushDevice).not.toHaveBeenCalled();
  });
});

describe("disableNativePushOnSignOut", () => {
  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it("deletes this installation's row and stops the shell", async () => {
    const plugin = fakePlugin();
    (globalThis as { Capacitor?: unknown }).Capacitor = iosScope(plugin).Capacitor;
    rememberNativeDevice("row-1");
    const api = { deletePushDevice: vi.fn(async () => undefined) };

    await disableNativePushOnSignOut(api);

    expect(api.deletePushDevice).toHaveBeenCalledWith("row-1");
    expect(rememberedNativeDevice()).toBeNull();
    expect(plugin.unregister).toHaveBeenCalledTimes(1);
  });

  it("also finishes a deletion an earlier attempt could not confirm", async () => {
    const plugin = fakePlugin();
    (globalThis as { Capacitor?: unknown }).Capacitor = iosScope(plugin).Capacitor;
    rememberPendingNativeDelete("row-old");
    const api = { deletePushDevice: vi.fn(async () => undefined) };

    await disableNativePushOnSignOut(api);

    expect(api.deletePushDevice).toHaveBeenCalledWith("row-old");
    expect(pendingNativeDelete()).toBeNull();
  });

  it("treats a 404 as the outcome being asked for", async () => {
    const plugin = fakePlugin();
    (globalThis as { Capacitor?: unknown }).Capacitor = iosScope(plugin).Capacitor;
    rememberNativeDevice("row-1");
    const api = {
      deletePushDevice: vi.fn(async () => {
        throw Object.assign(new Error("not found"), { status: 404 });
      }),
    };

    await disableNativePushOnSignOut(api);

    expect(pendingNativeDelete()).toBeNull();
    expect(plugin.unregister).toHaveBeenCalledTimes(1);
  });

  it("does not keep retrying a row another account now owns", async () => {
    const plugin = fakePlugin();
    (globalThis as { Capacitor?: unknown }).Capacitor = iosScope(plugin).Capacitor;
    rememberNativeDevice("row-1");
    const api = {
      deletePushDevice: vi.fn(async () => {
        throw Object.assign(new Error("forbidden"), { status: 403 });
      }),
    };

    await disableNativePushOnSignOut(api);

    expect(rememberedNativeDevice()).toBeNull();
    expect(pendingNativeDelete()).toBeNull();
    expect(plugin.unregister).toHaveBeenCalledTimes(1);
  });

  it("keeps the row for a retry when the node cannot be reached", async () => {
    const plugin = fakePlugin();
    (globalThis as { Capacitor?: unknown }).Capacitor = iosScope(plugin).Capacitor;
    rememberNativeDevice("row-1");
    const api = {
      deletePushDevice: vi.fn(async () => {
        throw new Error("offline");
      }),
    };

    await disableNativePushOnSignOut(api);

    expect(rememberedNativeDevice()).toBeNull();
    expect(pendingNativeDelete()).toBe("row-1");
    expect(plugin.unregister).toHaveBeenCalledTimes(1);
  });

  it("changes nothing outside the native shell", async () => {
    rememberNativeDevice("row-1");
    const api = { deletePushDevice: vi.fn(async () => undefined) };

    await disableNativePushOnSignOut(api);

    expect(api.deletePushDevice).not.toHaveBeenCalled();
    expect(rememberedNativeDevice()).toBe("row-1");
  });
});

describe("rememberedNativeDevice", () => {
  it("remembers and forgets which node row belongs to this installation", () => {
    expect(rememberedNativeDevice()).toBeNull();
    rememberNativeDevice("row-1");
    expect(rememberedNativeDevice()).toBe("row-1");
    forgetNativeDevice();
    expect(rememberedNativeDevice()).toBeNull();
  });
});

describe("pushErrorKey", () => {
  it("maps the reasons a person can act on", () => {
    expect(pushErrorKey("BadDeviceToken")).toBe("settings.nativePush.apnsErrors.token");
    expect(pushErrorKey("Unregistered")).toBe("settings.nativePush.apnsErrors.token");
    expect(pushErrorKey("ExpiredProviderToken")).toBe(
      "settings.nativePush.apnsErrors.credentials",
    );
    expect(pushErrorKey("TooManyRequests")).toBe("settings.nativePush.apnsErrors.rateLimited");
    expect(pushErrorKey("ServiceUnavailable")).toBe(
      "settings.nativePush.apnsErrors.unavailable",
    );
  });

  it("leaves an unknown reason to speak for itself", () => {
    expect(pushErrorKey("PayloadTooLarge")).toBeNull();
    expect(pushErrorKey("")).toBeNull();
  });
});

describe("clearDeliveredNotification", () => {
  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it("asks the shell to remove the banner for this kind and item", () => {
    const clearDelivered = vi.fn(async () => undefined);
    const plugin = fakePlugin({ clearDelivered });
    (globalThis as { Capacitor?: unknown }).Capacitor = iosScope(plugin).Capacitor;

    clearDeliveredNotification("approval", "appr-1");

    expect(clearDelivered).toHaveBeenCalledWith({ kind: "approval", id: "appr-1" });
  });

  it("is silent without the native shell, or when removal fails", async () => {
    expect(() => clearDeliveredNotification("approval", "appr-1")).not.toThrow();

    const clearDelivered = vi.fn(async () => {
      throw new Error("no such notification");
    });
    const plugin = fakePlugin({ clearDelivered });
    (globalThis as { Capacitor?: unknown }).Capacitor = iosScope(plugin).Capacitor;

    expect(() => clearDeliveredNotification("question", "q-1")).not.toThrow();
    await Promise.resolve();
    expect(clearDelivered).toHaveBeenCalledTimes(1);
  });
});

describe("deliveredNotificationTargets", () => {
  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
  });

  it("returns only the well-formed kin targets the shell still holds", async () => {
    const plugin = fakePlugin({
      deliveredTargets: vi.fn(async () => ({
        targets: [
          { kind: "approval", id: "appr-1" },
          { kind: "question", id: "q-1" },
          { kind: "task" },
          { kind: "", id: "nameless-kind" },
          { kind: "approval", id: 42 },
          null,
          "not a target",
        ],
      })),
    });
    (globalThis as { Capacitor?: unknown }).Capacitor = iosScope(plugin).Capacitor;

    await expect(deliveredNotificationTargets()).resolves.toEqual([
      { kind: "approval", id: "appr-1" },
      { kind: "question", id: "q-1" },
      { kind: "", id: "nameless-kind" },
    ]);
  });

  it("treats a missing, malformed, or failing answer as nothing delivered", async () => {
    await expect(deliveredNotificationTargets()).resolves.toEqual([]);

    const plugin = fakePlugin({
      deliveredTargets: vi.fn(async () => {
        throw new Error("shell is gone");
      }),
    });
    (globalThis as { Capacitor?: unknown }).Capacitor = iosScope(plugin).Capacitor;
    await expect(deliveredNotificationTargets()).resolves.toEqual([]);

    const noShape = fakePlugin({ deliveredTargets: vi.fn(async () => ({ targets: "nope" })) });
    (globalThis as { Capacitor?: unknown }).Capacitor = iosScope(noShape).Capacitor;
    await expect(deliveredNotificationTargets()).resolves.toEqual([]);
  });
});
