// @vitest-environment jsdom
// KIN-NOTIFY-001: one device block, one primary action, no secret on screen.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import type { NativePushPlugin } from "../../lib/nativePush";
import { NativePushSettings } from "./NativePushSettings";

/**
 * The device block has one job: say whether *this* device rings and offer the
 * one action that changes it. The browser half is tested in lib/nativePush;
 * here the states and the endpoints are pinned.
 */

const mocks = vi.hoisted(() => ({
  listPushDevices: vi.fn(),
  testPushDevice: vi.fn(),
  testNotify: vi.fn(),
  registerPushDevice: vi.fn(),
  deletePushDevice: vi.fn(),
  nativePushPlugin: vi.fn(),
  rememberedNativeDevice: vi.fn<() => string | null>(() => "row-1"),
  rememberNativeDevice: vi.fn(),
  forgetNativeDevice: vi.fn(),
  enableNativePush: vi.fn(),
  syncNativePush: vi.fn(),
  disableNativePush: vi.fn(),
  flushPendingNativeDelete: vi.fn(async () => false),
  pushErrorKey: vi.fn((reason: string) =>
    reason === "BadDeviceToken" ? "settings.nativePush.apnsErrors.token" : null,
  ),
  isNotFoundError: vi.fn(
    (e: unknown) =>
      !!e && typeof e === "object" && (e as { status?: number }).status === 404,
  ),
  isKinDesktop: vi.fn(() => false),
  openNotificationSettings: vi.fn<
    () => Promise<{ ok: true } | { ok: false; error: string }>
  >(async () => ({ ok: true })),
  NativePushPermissionError: class NativePushPermissionError extends Error {
    constructor(readonly permission: string) {
      super(`notification permission is ${permission}`);
    }
  },
}));

vi.mock("../../api/client", () => ({
  listPushDevices: mocks.listPushDevices,
  testPushDevice: mocks.testPushDevice,
  testNotify: mocks.testNotify,
  registerPushDevice: mocks.registerPushDevice,
  deletePushDevice: mocks.deletePushDevice,
}));

vi.mock("../../lib/nativePush", () => ({
  nativePushPlugin: mocks.nativePushPlugin,
  rememberedNativeDevice: mocks.rememberedNativeDevice,
  rememberNativeDevice: mocks.rememberNativeDevice,
  forgetNativeDevice: mocks.forgetNativeDevice,
  enableNativePush: mocks.enableNativePush,
  syncNativePush: mocks.syncNativePush,
  disableNativePush: mocks.disableNativePush,
  flushPendingNativeDelete: mocks.flushPendingNativeDelete,
  pushErrorKey: mocks.pushErrorKey,
  isNotFoundError: mocks.isNotFoundError,
  NativePushPermissionError: mocks.NativePushPermissionError,
}));

vi.mock("../../lib/desktop", () => ({
  isKinDesktop: mocks.isKinDesktop,
  openNotificationSettings: mocks.openNotificationSettings,
}));

const plugin: NativePushPlugin = {
  permission: vi.fn(async () => ({ status: "granted" as const })),
  requestPermission: vi.fn(async () => ({ status: "granted" as const })),
  register: vi.fn(),
  unregister: vi.fn(async () => undefined),
  openSettings: vi.fn(async () => undefined),
};

const device = {
  id: "row-1",
  platform: "ios",
  name: "iPhone",
  environment: "sandbox",
  created_at: 1,
  updated_at: 2,
  last_ok_at: 3,
  last_error: "",
};

beforeEach(() => {
  setLocale("en");
  vi.clearAllMocks();
  mocks.isKinDesktop.mockReturnValue(false);
  mocks.openNotificationSettings.mockResolvedValue({ ok: true });
  mocks.nativePushPlugin.mockReturnValue(null);
  mocks.rememberedNativeDevice.mockReturnValue("row-1");
  mocks.listPushDevices.mockResolvedValue({ devices: [device], apns_configured: true });
  mocks.disableNativePush.mockResolvedValue({ pending: false });
  mocks.flushPendingNativeDelete.mockResolvedValue(false);
  vi.mocked(plugin.permission).mockResolvedValue({ status: "granted" });
  vi.mocked(plugin.openSettings).mockResolvedValue(undefined);
});

describe("NativePushSettings", () => {
  it("only explains native apps in a plain browser", async () => {
    render(<NativePushSettings />);
    expect(
      await screen.findByText(/notifications are delivered by the Kin apps/i),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /turn on for this iphone/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /send test/i })).toBeNull();
    expect(screen.queryByText(/bark/i)).toBeNull();
    expect(screen.queryByText(/ntfy/i)).toBeNull();
    expect(mocks.listPushDevices).not.toHaveBeenCalled();
  });

  it("shows this iPhone as on and offers test and turn off", async () => {
    mocks.nativePushPlugin.mockReturnValue(plugin);
    render(<NativePushSettings />);

    expect(await screen.findByText("On")).toBeTruthy();
    expect(screen.getByText("This iPhone")).toBeTruthy();
    expect(screen.queryByText(/browser push/i)).toBeNull();
    expect(screen.getByRole("button", { name: /send test/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /turn off/i })).toBeTruthy();
  });

  it("offers the system settings when iOS blocked notifications", async () => {
    mocks.nativePushPlugin.mockReturnValue(plugin);
    vi.mocked(plugin.permission).mockResolvedValue({ status: "denied" });
    render(<NativePushSettings />);

    expect(await screen.findByText("Blocked by iOS")).toBeTruthy();
    const open = await screen.findByRole("button", { name: /open settings/i });
    await userEvent.click(open);
    expect(plugin.openSettings).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /turn on for this iphone/i })).toBeNull();
  });

  it("translates a provider reason a person can act on", async () => {
    mocks.nativePushPlugin.mockReturnValue(plugin);
    mocks.testPushDevice.mockResolvedValue({
      ok: false,
      configured: true,
      results: [{ channel: "apns", device: "row-1", ok: false, error: "BadDeviceToken" }],
    });
    render(<NativePushSettings />);

    await userEvent.click(await screen.findByRole("button", { name: /send test/i }));
    expect(await screen.findByText(/Apple rejected this phone's notification token/i)).toBeTruthy();
    expect(screen.queryByText(/BadDeviceToken/)).toBeNull();
    expect(mocks.testPushDevice).toHaveBeenCalledWith("row-1");
  });

  it("keeps a provider reason it does not know", async () => {
    mocks.nativePushPlugin.mockReturnValue(plugin);
    mocks.testPushDevice.mockResolvedValue({
      ok: false,
      configured: true,
      results: [{ channel: "apns", device: "row-1", ok: false, error: "PayloadTooLarge" }],
    });
    render(<NativePushSettings />);

    await userEvent.click(await screen.findByRole("button", { name: /send test/i }));
    expect(await screen.findByText(/PayloadTooLarge/)).toBeTruthy();
  });

  it("forgets a registration whose login ended instead of showing a raw 410", async () => {
    mocks.nativePushPlugin.mockReturnValue(plugin);
    mocks.testPushDevice.mockRejectedValueOnce(
      Object.assign(new Error("device session has ended"), { status: 410 }),
    );
    render(<NativePushSettings />);

    await userEvent.click(await screen.findByRole("button", { name: /send test/i }));
    expect(await screen.findByText(/sign-in has ended/i)).toBeTruthy();
    expect(screen.queryByText(/device session has ended/i)).toBeNull();
    expect(mocks.forgetNativeDevice).toHaveBeenCalled();
    await waitFor(() => expect(mocks.listPushDevices).toHaveBeenCalledTimes(2));
  });

  it("forgets a registration the node no longer has instead of showing a raw 404", async () => {
    mocks.nativePushPlugin.mockReturnValue(plugin);
    mocks.testPushDevice.mockRejectedValueOnce(
      Object.assign(new Error("device not found"), { status: 404 }),
    );
    render(<NativePushSettings />);

    await userEvent.click(await screen.findByRole("button", { name: /send test/i }));
    expect(await screen.findByText(/no longer has a registration/i)).toBeTruthy();
    expect(screen.queryByText(/device not found/i)).toBeNull();
    expect(mocks.forgetNativeDevice).toHaveBeenCalled();
    await waitFor(() => expect(mocks.listPushDevices).toHaveBeenCalledTimes(2));
  });

  it("says the node has no APNs credentials instead of pretending it sent", async () => {
    mocks.nativePushPlugin.mockReturnValue(plugin);
    mocks.listPushDevices.mockResolvedValue({ devices: [], apns_configured: false });
    mocks.rememberedNativeDevice.mockReturnValue(null);
    vi.mocked(plugin.permission).mockResolvedValue({ status: "prompt" });
    render(<NativePushSettings />);

    expect(await screen.findByText(/cannot send to iPhone yet/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /turn on for this iphone/i })).toBeTruthy();
  });

  it("turns this iPhone off on both sides", async () => {
    mocks.nativePushPlugin.mockReturnValue(plugin);
    mocks.disableNativePush.mockResolvedValue({ pending: false });
    mocks.listPushDevices
      .mockResolvedValueOnce({ devices: [device], apns_configured: true })
      .mockResolvedValue({ devices: [], apns_configured: true });
    render(<NativePushSettings />);

    await userEvent.click(await screen.findByRole("button", { name: /turn off/i }));
    await waitFor(() => expect(mocks.disableNativePush).toHaveBeenCalledWith(plugin, expect.anything(), "row-1"));
    expect(mocks.forgetNativeDevice).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: /turn on for this iphone/i })).toBeTruthy();
  });

  it("offers a Mac test in the desktop shell", async () => {
    mocks.isKinDesktop.mockReturnValue(true);
    mocks.listPushDevices.mockResolvedValue({ devices: [], apns_configured: false });
    mocks.testNotify.mockResolvedValue({
      ok: true,
      results: [{ channel: "desktop", ok: true, status: "ok" }],
    });
    render(<NativePushSettings />);

    expect(await screen.findByText("This Mac")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /send test/i }));
    // Desktop only: the Mac test must not ring every registered phone.
    await waitFor(() => expect(mocks.testNotify).toHaveBeenCalledWith("desktop"));
    expect(await screen.findByText(/test notification sent/i)).toBeTruthy();
    // A Mac node with no phones is a normal state, not an error.
    expect(screen.queryByText(/cannot send to iPhone yet/i)).toBeNull();
  });

  it("takes the Mac reader to the pane that owns the permission", async () => {
    mocks.isKinDesktop.mockReturnValue(true);
    mocks.listPushDevices.mockResolvedValue({ devices: [], apns_configured: false });
    render(<NativePushSettings />);

    expect(await screen.findByText("Managed by macOS")).toBeTruthy();
    expect(screen.getByText(/macOS does not give the app/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /open settings/i }));
    expect(mocks.openNotificationSettings).toHaveBeenCalledTimes(1);
  });

  it("rereads the permission when the reader returns from iOS Settings", async () => {
    mocks.nativePushPlugin.mockReturnValue(plugin);
    mocks.rememberedNativeDevice.mockReturnValue(null);
    mocks.listPushDevices.mockResolvedValue({ devices: [], apns_configured: true });
    vi.mocked(plugin.permission).mockResolvedValue({ status: "denied" });
    render(<NativePushSettings />);
    expect(await screen.findByText("Blocked by iOS")).toBeTruthy();

    vi.mocked(plugin.permission).mockResolvedValue({ status: "granted" });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await screen.findByText("Off")).toBeTruthy();
  });

  it("shows unknown, not the remembered state, when the node is unreachable", async () => {
    mocks.nativePushPlugin.mockReturnValue(plugin);
    mocks.listPushDevices.mockRejectedValue(new Error("network down"));
    render(<NativePushSettings />);

    // Wait for the failed load to land before reading the status; the loading
    // state also says "Unknown", which would pass without proving anything.
    expect(await screen.findByText("network down")).toBeTruthy();
    expect(screen.getByText("Unknown")).toBeTruthy();
    expect(screen.queryByText("On")).toBeNull();
  });

  it("says so when the system settings panes cannot be opened", async () => {
    mocks.isKinDesktop.mockReturnValue(true);
    mocks.listPushDevices.mockResolvedValue({ devices: [], apns_configured: false });
    mocks.openNotificationSettings.mockResolvedValue({ ok: false, error: "nope" });
    render(<NativePushSettings />);

    await userEvent.click(await screen.findByRole("button", { name: /open settings/i }));
    expect(await screen.findByText(/could not open system settings/i)).toBeTruthy();
  });

  it("refreshes the token on load even when the row is already listed", async () => {
    // A token rotated while the app was closed; the registered row still exists,
    // so only asking the shell for the current token repairs it.
    mocks.nativePushPlugin.mockReturnValue(plugin);
    mocks.syncNativePush.mockResolvedValue({
      id: "row-1",
      registration: { installId: "install-1", token: "fresh", environment: "sandbox" },
    });
    render(<NativePushSettings />);

    await waitFor(() =>
      expect(mocks.syncNativePush).toHaveBeenCalledWith(plugin, expect.anything()),
    );
    expect(await screen.findByText("On")).toBeTruthy();
  });

  it("leaves the on state when Apple says the token is gone", async () => {
    mocks.nativePushPlugin.mockReturnValue(plugin);
    mocks.testPushDevice.mockResolvedValue({
      ok: false,
      configured: true,
      expired: true,
      results: [{ channel: "apns", device: "row-1", ok: false, error: "Unregistered" }],
    });
    mocks.listPushDevices
      .mockResolvedValueOnce({ devices: [device], apns_configured: true })
      .mockResolvedValue({ devices: [], apns_configured: true });
    render(<NativePushSettings />);

    await userEvent.click(await screen.findByRole("button", { name: /send test/i }));
    expect(await screen.findByText(/notification token is no longer valid/i)).toBeTruthy();
    expect(mocks.forgetNativeDevice).toHaveBeenCalled();
    // Enable again is what mints a new token; the deleted row cannot be tested
    // or turned off again.
    expect(await screen.findByRole("button", { name: /turn on for this iphone/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /turn off/i })).toBeNull();
  });

  it("keeps an unconfirmed deletion retryable", async () => {
    mocks.nativePushPlugin.mockReturnValue(plugin);
    mocks.disableNativePush.mockResolvedValue({ pending: true });
    render(<NativePushSettings />);

    await userEvent.click(await screen.findByRole("button", { name: /turn off/i }));
    expect(await screen.findByText(/will be removed the next time/i)).toBeTruthy();
    // This phone is off locally, but the node row still exists, so the block
    // offers enable rather than claiming it is on.
    expect(await screen.findByRole("button", { name: /turn on for this iphone/i })).toBeTruthy();
  });

  it("translates the registry's machine values for the reader", async () => {
    // The node stores Apple's tokens ("ios", "production"). Neither is a word a
    // person should have to decode in a settings list.
    mocks.listPushDevices.mockResolvedValue({
      devices: [{ ...device, name: "", environment: "production" }],
      apns_configured: true,
    });
    mocks.nativePushPlugin.mockReturnValue(plugin);
    render(<NativePushSettings />);

    expect(await screen.findByText("iPhone")).toBeTruthy();
    expect(screen.getByText("Production")).toBeTruthy();
    expect(screen.queryByText("production")).toBeNull();
  });

  it("renders the device block in Chinese", async () => {
    setLocale("zh");
    mocks.nativePushPlugin.mockReturnValue(plugin);
    render(<NativePushSettings />);

    expect(await screen.findByText("这台 iPhone")).toBeTruthy();
    expect(screen.getByText("沙盒")).toBeTruthy();
    expect(screen.getByRole("button", { name: "发送测试" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
  });
});
