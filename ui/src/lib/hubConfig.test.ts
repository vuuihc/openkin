// @vitest-environment jsdom
// G8/G9: the console half of the shell's Hub-URL and system-browser contract.
import { describe, expect, it } from "vitest";
import {
  hubConfigPlugin,
  isHubShell,
  newDeviceKey,
  parseAuthCallback,
  type HubConfigPlugin,
} from "./hubConfig";

function iosScope(plugin: Partial<HubConfigPlugin>) {
  return {
    Capacitor: {
      isNativePlatform: () => true,
      getPlatform: () => "ios",
      Plugins: { KinHubConfig: plugin },
    },
  };
}

function fullPlugin(): Partial<HubConfigPlugin> {
  return {
    getHubUrl: () => Promise.resolve({}),
    setHubUrl: () => Promise.resolve({ url: "https://kin.example.com" }),
    clearHubUrl: () => Promise.resolve(),
    openSystemBrowser: () => Promise.resolve(),
    takeAuthCallback: () => Promise.resolve({}),
  };
}

describe("hubConfigPlugin", () => {
  it("finds the plugin inside the iOS shell", () => {
    expect(hubConfigPlugin(iosScope(fullPlugin()))).not.toBeNull();
    expect(isHubShell(iosScope(fullPlugin()))).toBe(true);
  });

  it("is null in a browser", () => {
    expect(hubConfigPlugin({})).toBeNull();
    expect(isHubShell({})).toBe(false);
  });

  it("is null on a shell build that predates the plugin", () => {
    expect(hubConfigPlugin(iosScope({}))).toBeNull();
  });

  it("refuses a plugin missing the methods the console calls", () => {
    const { setHubUrl: _dropped, ...partial } = fullPlugin();
    expect(hubConfigPlugin(iosScope(partial))).toBeNull();
  });
});

describe("parseAuthCallback", () => {
  it("reads a success callback", () => {
    const code = "a".repeat(64);
    expect(parseAuthCallback(`kin://auth-callback?code=${code}&device_key=k1`)).toEqual({
      kind: "code",
      code,
      deviceKey: "k1",
    });
  });

  it("reads an error callback as the server's stable code", () => {
    expect(parseAuthCallback("kin://auth-callback?error=identity_not_linked")).toEqual({
      kind: "error",
      code: "identity_not_linked",
    });
  });

  it("rejects a foreign scheme or host", () => {
    const code = "a".repeat(64);
    expect(parseAuthCallback(`https://auth-callback?code=${code}&device_key=k1`)).toBeNull();
    expect(parseAuthCallback(`kin://other?code=${code}&device_key=k1`)).toBeNull();
  });

  it("rejects a malformed code and a missing device key", () => {
    expect(parseAuthCallback("kin://auth-callback?code=short&device_key=k1")).toBeNull();
    expect(parseAuthCallback(`kin://auth-callback?code=${"a".repeat(64)}`)).toBeNull();
    expect(parseAuthCallback("")).toBeNull();
    expect(parseAuthCallback("not a url")).toBeNull();
  });
});

describe("newDeviceKey", () => {
  it("is 64 hex characters, like the codes it accompanies", () => {
    expect(newDeviceKey()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not repeat", () => {
    expect(newDeviceKey()).not.toBe(newDeviceKey());
  });
});
