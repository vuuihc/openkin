// @vitest-environment jsdom
// G8: the shell-only entry form. The deep-link pre-fill is the piece a test
// can pin: the shell's connect slot is read on mount and its origin lands in
// the field — the person still taps connect, so the rest of the form's
// behavior is the shell contract already covered by the Swift side.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/** Install the shell plugin with only the Hub-URL call under test's control. */
function shellWithSetHubUrl(setHubUrl: HubConfigPlugin["setHubUrl"]) {
  const scope = globalThis as { Capacitor?: unknown };
  scope.Capacitor = iosScope({
    getHubUrl: () => Promise.resolve({ url: "" }),
    setHubUrl,
    clearHubUrl: () => Promise.resolve(),
    openSystemBrowser: () => Promise.resolve(),
    takeAuthCallback: () => Promise.resolve({ url: "" }),
    takeConnectLink: () => Promise.resolve({ url: "" }),
  });
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

/**
 * E6: both ways to connect are the console's shared button.
 *
 * The token paste is the browser's form and the Hub address is the shell's;
 * they are two surfaces now drawing the same control. The warning confirm is
 * the one deliberately *not* filled — it is the second tap on a decision the
 * person has not made yet, not the screen's primary action.
 */
describe("the connect screen's actions", () => {
  it("puts the connect screen's actions on the shared button facade", async () => {
    render(<ConnectScreen reason="missing" />);

    const tokenSubmit = screen.getByRole("button", { name: "Connect" });
    expect(tokenSubmit.className.split(/\s+/)).toContain("kin-btn");
    expect(tokenSubmit.className.split(/\s+/)).toContain("kin-btn-primary");

    cleanup();

    shellWithSetHubUrl(() => Promise.resolve({ url: "http://kin.example.com", insecure: true }));
    render(<ConnectScreen reason="missing" />);

    const field = await screen.findByPlaceholderText("https://kin.example.com");
    const hubSubmit = screen.getByRole("button", { name: "Use this Hub" });
    expect(hubSubmit.className.split(/\s+/)).toContain("kin-btn");
    expect(hubSubmit.className.split(/\s+/)).toContain("kin-btn-primary");

    fireEvent.change(field, { target: { value: "http://kin.example.com" } });
    fireEvent.click(hubSubmit);

    const confirm = await screen.findByRole("button", { name: "Continue anyway" });
    expect(confirm.className.split(/\s+/)).toContain("kin-btn");
    expect(confirm.className.split(/\s+/)).toContain("kin-btn-secondary");
    expect(confirm.className.split(/\s+/)).not.toContain("kin-btn-primary");
  });

  it("keeps the plain-HTTP warning as a second tap", async () => {
    const setHubUrl = vi.fn(({ url, confirm }: { url: string; confirm?: boolean }) =>
      Promise.resolve(confirm ? { url } : { url, insecure: true }),
    );
    shellWithSetHubUrl(setHubUrl);

    render(<ConnectScreen reason="missing" />);

    const field = await screen.findByPlaceholderText("https://kin.example.com");
    fireEvent.change(field, { target: { value: "http://kin.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this Hub" }));

    // The first tap answers `insecure`: the shell saved nothing and the
    // warning is now the thing to read before the confirming tap.
    await waitFor(() => expect(setHubUrl).toHaveBeenCalledTimes(1));
    expect(setHubUrl).toHaveBeenNthCalledWith(1, {
      url: "http://kin.example.com",
      confirm: false,
    });
    expect(screen.getByRole("alert").textContent).toContain("This address is not HTTPS");

    fireEvent.click(screen.getByRole("button", { name: "Continue anyway" }));

    await waitFor(() => expect(setHubUrl).toHaveBeenCalledTimes(2));
    expect(setHubUrl).toHaveBeenNthCalledWith(2, {
      url: "http://kin.example.com",
      confirm: true,
    });
  });
});
