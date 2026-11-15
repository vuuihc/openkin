// @vitest-environment jsdom
// G8: the shell-only entry form. The deep-link pre-fill is the piece a test
// can pin: the shell's connect slot is read on mount and its origin lands in
// the field — the person still taps connect, so the rest of the form's
// behavior is the shell contract already covered by the Swift side.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { setLocale } from "../i18n";
import ConnectScreen from "./ConnectScreen";
import type { HubConfigPlugin } from "../lib/hubConfig";

function iosScope(plugin: Record<string, unknown>) {
  // The object the test assigns to globalThis: Capacitor at its top level,
  // the way the real shell injects it.
  return {
    isNativePlatform: () => true,
    getPlatform: () => "ios",
    Plugins: { KinHubConfig: plugin },
  };
}

beforeEach(() => {
  setLocale("en");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  const scope = globalThis as { Capacitor?: unknown };
  delete scope.Capacitor;
});

describe("ConnectScreen's shell deep link", () => {
  it("pre-fills the Hub URL from the shell's connect slot", async () => {
    const takeConnectLink = vi.fn(() =>
      Promise.resolve({ url: "kin://connect?url=https%3A%2F%2Fkin.example.com" }),
    );
    const scope = globalThis as { Capacitor?: unknown };
    scope.Capacitor = iosScope({
      getHubUrl: () => Promise.resolve({ url: "" }),
      setHubUrl: () => Promise.resolve({ url: "" }),
      clearHubUrl: () => Promise.resolve(),
      openSystemBrowser: () => Promise.resolve(),
      takeAuthCallback: () => Promise.resolve({ url: "" }),
      takeConnectLink,
    });

    render(<ConnectScreen reason="missing" />);
    const field = await screen.findByPlaceholderText("https://kin.example.com");
    expect((field as HTMLInputElement).value).toBe("https://kin.example.com");
    expect(takeConnectLink).toHaveBeenCalled();
  });

  it("leaves the field empty when the shell holds no connect link", async () => {
    const scope = globalThis as { Capacitor?: unknown };
    scope.Capacitor = iosScope({
      getHubUrl: () => Promise.resolve({ url: "" }),
      setHubUrl: () => Promise.resolve({ url: "" }),
      clearHubUrl: () => Promise.resolve(),
      openSystemBrowser: () => Promise.resolve(),
      takeAuthCallback: () => Promise.resolve({ url: "" }),
      takeConnectLink: () => Promise.resolve({ url: "" }),
    });

    render(<ConnectScreen reason="missing" />);
    const field = await screen.findByPlaceholderText("https://kin.example.com");
    expect((field as HTMLInputElement).value).toBe("");
  });

  it("treats an old shell build without takeConnectLink as no link", async () => {
    const plugin: Partial<HubConfigPlugin> & Record<string, unknown> = {
      getHubUrl: () => Promise.resolve({ url: "" }),
      setHubUrl: () => Promise.resolve({ url: "" }),
      clearHubUrl: () => Promise.resolve(),
      openSystemBrowser: () => Promise.resolve(),
      takeAuthCallback: () => Promise.resolve({ url: "" }),
    };
    const scope = globalThis as { Capacitor?: unknown };
    scope.Capacitor = iosScope(plugin);

    render(<ConnectScreen reason="missing" />);
    const field = await screen.findByPlaceholderText("https://kin.example.com");
    expect((field as HTMLInputElement).value).toBe("");
  });
});
