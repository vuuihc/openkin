// @vitest-environment jsdom
// G8/G9: the console half of the shell's Hub-URL and system-browser contract.
import { describe, expect, it } from "vitest";
import {
  forgetHubSession,
  hubConfigPlugin,
  isHubShell,
  newDeviceKey,
  parseAuthCallback,
  parseConnectLink,
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
    setHubUrl: (_input: { url: string; confirm?: boolean }) =>
      Promise.resolve({ url: "https://kin.example.com" }),
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

describe("forgetHubSession", () => {
  it("tells the shell to drop its durable copy", async () => {
    let forgotten = 0;
    const plugin = { ...fullPlugin(), forgetSession: async () => void forgotten++ };
    await forgetHubSession(iosScope(plugin));
    expect(forgotten).toBe(1);
  });

  it("does nothing in a browser or on an older shell build", async () => {
    await expect(forgetHubSession({})).resolves.toBeUndefined();
    await expect(forgetHubSession(iosScope(fullPlugin()))).resolves.toBeUndefined();
  });

  it("does not fail the sign-out when the shell refuses", async () => {
    const plugin = { ...fullPlugin(), forgetSession: async () => Promise.reject(new Error("nope")) };
    await expect(forgetHubSession(iosScope(plugin))).resolves.toBeUndefined();
  });
});

describe("parseAuthCallback", () => {
  it("reads a success callback: code only, no device key in the browser hop", () => {
    const code = "a".repeat(64);
    expect(parseAuthCallback(`kin://auth-callback?code=${code}`)).toEqual({
      kind: "code",
      code,
    });
  });

  it("reads an error callback with its device key for attribution", () => {
    expect(parseAuthCallback("kin://auth-callback?error=identity_not_linked&device_key=k1")).toEqual({
      kind: "error",
      code: "identity_not_linked",
      deviceKey: "k1",
    });
    expect(parseAuthCallback("kin://auth-callback?error=identity_not_linked")).toEqual({
      kind: "error",
      code: "identity_not_linked",
      deviceKey: "",
    });
  });

  it("rejects a foreign scheme or host", () => {
    const code = "a".repeat(64);
    expect(parseAuthCallback(`https://auth-callback?code=${code}`)).toBeNull();
    expect(parseAuthCallback(`kin://other?code=${code}`)).toBeNull();
  });

  it("rejects a malformed code", () => {
    expect(parseAuthCallback("kin://auth-callback?code=short")).toBeNull();
    expect(parseAuthCallback("kin://auth-callback?code=short&error=x")).toEqual({
      kind: "error",
      code: "x",
      deviceKey: "",
    });
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

// G8: 深链填入 Hub URL. The link says where the Hub is, not that the person
// has decided to trust it — so the parser stops at the origin and the connect
// screen keeps its own submit (and insecure-HTTP confirm) as the deciding tap.
describe("parseConnectLink", () => {
  it("reads the origin out of a connect deep link", () => {
    expect(parseConnectLink("kin://connect?url=https%3A%2F%2Fkin.example.com")).toBe(
      "https://kin.example.com",
    );
    // Path, port, and query are preserved as given; only the scheme normalization
    // a URL constructor applies may change them.
    expect(
      parseConnectLink("kin://connect?url=https%3A%2F%2Fhub.example.com%3A8443%2Fconsole"),
    ).toBe("https://hub.example.com:8443");
    expect(parseConnectLink("kin://connect?url=http%3A%2F%2F192.168.1.42%3A7777")).toBe(
      "http://192.168.1.42:7777",
    );
  });

  it("rejects anything that is not an http(s) origin", () => {
    expect(parseConnectLink("kin://connect?url=ftp://kin.example.com")).toBeNull();
    expect(parseConnectLink("kin://connect?url=javascript:alert(1)")).toBeNull();
    expect(parseConnectLink("kin://connect")).toBeNull();
    expect(parseConnectLink("kin://connect?url=")).toBeNull();
    expect(parseConnectLink("https://kin.example.com")).toBeNull();
    expect(parseConnectLink("kin://other?url=https://kin.example.com")).toBeNull();
    expect(parseConnectLink("")).toBeNull();
    expect(parseConnectLink("not a url")).toBeNull();
  });
});
