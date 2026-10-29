// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import { PushSettingsSection } from "./PushSettingsSection";

/**
 * The section's job is to show the browser's state and to ask the daemon only
 * when the reader acts. The browser half is covered in lib/push.test.ts; what
 * is pinned here is that each state offers the right control, and that the two
 * side-effecting actions talk to the endpoints they claim to.
 */

const mocks = vi.hoisted(() => ({
  pushSupported: vi.fn(() => true),
  pushPermission: vi.fn<() => NotificationPermission | "unsupported">(() => "default"),
  requestPushPermission: vi.fn<() => Promise<NotificationPermission>>(async () => "granted"),
  currentPushSubscription: vi.fn(async (): Promise<unknown> => null),
  enablePush: vi.fn(),
  disablePush: vi.fn(),
  serializeSubscription: vi.fn(),
  getPushConfig: vi.fn(),
  subscribePush: vi.fn(),
  unsubscribePush: vi.fn(),
  testPush: vi.fn(),
  PushPermissionError: class PushPermissionError extends Error {},
  PushUnsubscribeError: class PushUnsubscribeError extends Error {},
}));

vi.mock("../../lib/push", () => ({
  pushSupported: mocks.pushSupported,
  pushPermission: mocks.pushPermission,
  requestPushPermission: mocks.requestPushPermission,
  currentPushSubscription: mocks.currentPushSubscription,
  enablePush: mocks.enablePush,
  disablePush: mocks.disablePush,
  serializeSubscription: mocks.serializeSubscription,
  PushPermissionError: mocks.PushPermissionError,
  PushUnsubscribeError: mocks.PushUnsubscribeError,
}));

vi.mock("../../api/client", () => ({
  getPushConfig: mocks.getPushConfig,
  subscribePush: mocks.subscribePush,
  unsubscribePush: mocks.unsubscribePush,
  testPush: mocks.testPush,
}));

beforeEach(() => {
  setLocale("en");
  vi.clearAllMocks();
  mocks.pushSupported.mockReturnValue(true);
  mocks.pushPermission.mockReturnValue("default");
  mocks.requestPushPermission.mockResolvedValue("granted");
  mocks.currentPushSubscription.mockResolvedValue(null);
});

describe("PushSettingsSection", () => {
  it("says so when the browser cannot receive push", async () => {
    mocks.pushSupported.mockReturnValue(false);
    render(<PushSettingsSection />);
    expect(await screen.findByText(/cannot receive push/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /enable on this device/i })).toBeNull();
  });

  it("starts from the browser's state, not from the daemon", async () => {
    render(<PushSettingsSection />);
    // Nothing is fetched until the reader acts: the config endpoint mints the
    // node's key pair, and opening settings is not consent to that.
    expect(await screen.findByRole("button", { name: /enable on this device/i })).toBeTruthy();
    expect(mocks.getPushConfig).not.toHaveBeenCalled();
  });

  it("explains a denied permission instead of offering a button that cannot work", async () => {
    mocks.pushPermission.mockReturnValue("denied");
    render(<PushSettingsSection />);
    expect(await screen.findByText(/blocked for this site/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /enable on this device/i })).toBeNull();
  });

  it("enables, registers and then offers a test", async () => {
    const subscription = { endpoint: "https://push.example.net/a" };
    mocks.currentPushSubscription
      .mockResolvedValueOnce(null)
      .mockResolvedValue(subscription);
    mocks.getPushConfig.mockResolvedValue({ public_key: "AQID", subscribed: 0 });
    mocks.enablePush.mockResolvedValue(subscription);
    mocks.serializeSubscription.mockReturnValue({
      endpoint: "https://push.example.net/a",
      keys: { p256dh: "p", auth: "a" },
    });
    mocks.subscribePush.mockResolvedValue({ id: "row-1" });

    render(<PushSettingsSection />);
    const enable = await screen.findByRole("button", { name: /enable on this device/i });
    await userEvent.click(enable);

    await waitFor(() => expect(mocks.subscribePush).toHaveBeenCalledTimes(1));
    expect(mocks.getPushConfig).toHaveBeenCalledTimes(1);
    expect(mocks.enablePush).toHaveBeenCalledWith("AQID");
    expect(mocks.subscribePush).toHaveBeenCalledWith({
      endpoint: "https://push.example.net/a",
      keys: { p256dh: "p", auth: "a" },
    });
    expect(await screen.findByText(/this device is subscribed/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /send test/i })).toBeTruthy();
  });

  it("unsubscribes both sides when turned off", async () => {
    const subscription = { endpoint: "https://push.example.net/a" };
    mocks.currentPushSubscription.mockResolvedValue(subscription);
    mocks.disablePush.mockResolvedValue("https://push.example.net/a");
    mocks.unsubscribePush.mockResolvedValue(undefined);

    render(<PushSettingsSection />);
    const off = await screen.findByRole("button", { name: /turn off/i });
    await userEvent.click(off);

    await waitFor(() =>
      expect(mocks.unsubscribePush).toHaveBeenCalledWith("https://push.example.net/a"),
    );
    expect(await screen.findByRole("button", { name: /enable on this device/i })).toBeTruthy();
  });

  it("asks for the permission before it fetches the key", async () => {
    // WebKit drops the user activation at the first await. Asking after the
    // config round trip means the prompt is ignored on iOS, which is the one
    // platform the section's own hint tells people to use.
    mocks.getPushConfig.mockResolvedValue({ public_key: "AQID", subscribed: 0 });
    mocks.enablePush.mockResolvedValue({ endpoint: "https://push.example.net/a" });
    mocks.serializeSubscription.mockReturnValue({
      endpoint: "https://push.example.net/a",
      keys: { p256dh: "p", auth: "a" },
    });
    mocks.subscribePush.mockResolvedValue({ id: "row-1" });

    render(<PushSettingsSection />);
    await userEvent.click(await screen.findByRole("button", { name: /enable on this device/i }));

    await waitFor(() => expect(mocks.getPushConfig).toHaveBeenCalledTimes(1));
    expect(mocks.requestPushPermission.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.getPushConfig.mock.invocationCallOrder[0],
    );
  });

  it("does not fetch the key when the permission is refused", async () => {
    mocks.requestPushPermission.mockResolvedValue("denied");

    render(<PushSettingsSection />);
    await userEvent.click(await screen.findByRole("button", { name: /enable on this device/i }));

    expect(await screen.findByText(/blocked for this site/i)).toBeTruthy();
    expect(mocks.getPushConfig).not.toHaveBeenCalled();
    expect(mocks.enablePush).not.toHaveBeenCalled();
  });

  it("keeps the device on when the browser refuses to unsubscribe", async () => {
    mocks.currentPushSubscription.mockResolvedValue({ endpoint: "https://push.example.net/a" });
    mocks.disablePush.mockRejectedValue(new mocks.PushUnsubscribeError());

    render(<PushSettingsSection />);
    await userEvent.click(await screen.findByRole("button", { name: /turn off/i }));

    await waitFor(() => expect(mocks.disablePush).toHaveBeenCalledTimes(1));
    expect(mocks.unsubscribePush).not.toHaveBeenCalled();
    // Still on, because it still is.
    expect(screen.getByRole("button", { name: /turn off/i })).toBeTruthy();
  });

  it("sends the test through the push endpoint, not the webhook one", async () => {
    mocks.currentPushSubscription.mockResolvedValue({ endpoint: "https://push.example.net/a" });
    mocks.testPush.mockResolvedValue({ ok: true, results: [{ channel: "push", ok: true }] });

    render(<PushSettingsSection />);
    await userEvent.click(await screen.findByRole("button", { name: /send test/i }));
    await waitFor(() => expect(mocks.testPush).toHaveBeenCalledTimes(1));
  });
});
