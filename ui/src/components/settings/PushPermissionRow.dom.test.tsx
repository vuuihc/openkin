// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PushPermissionRow } from "./PushPermissionRow";
import { setLocale } from "../../i18n";
import type { NativePushApi, NativePushPlugin } from "../../lib/nativePush";

/**
 * KIN-NOTIFY-001: the iPhone shell's one remaining notification control.
 *
 * R0b-3 deleted the Notifications settings tab, but iOS does not add an app to
 * Settings → Notifications until it has asked for the permission once, and the
 * ask must come from a tap. This row is that tap: it appears only inside the
 * shell, disappears once granted, and points a denied phone at the system
 * settings that own the switch.
 */

function pluginWith(
  status: "granted" | "denied" | "prompt",
  overrides: Partial<NativePushPlugin> = {},
): NativePushPlugin {
  return {
    permission: vi.fn(async () => ({ status })),
    requestPermission: vi.fn(async () => ({ status: "granted" as const })),
    register: vi.fn(async () => ({
      installId: "install-1",
      token: "token-1",
      environment: "production" as const,
    })),
    unregister: vi.fn(async () => undefined),
    openSettings: vi.fn(async () => undefined),
    ...overrides,
  };
}

function apiWith(): NativePushApi {
  return {
    registerPushDevice: vi.fn(async () => ({ id: "device-1" })),
    deletePushDevice: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  setLocale("en");
  localStorage.clear();
});

describe("PushPermissionRow", () => {
  it("renders nothing outside the iPhone shell", () => {
    const { container } = render(<PushPermissionRow plugin={null} api={apiWith()} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing once the phone already granted notifications", async () => {
    const plugin = pluginWith("granted");
    const { container } = render(<PushPermissionRow plugin={plugin} api={apiWith()} />);
    await waitFor(() => expect(plugin.permission).toHaveBeenCalled());
    expect(container.innerHTML).toBe("");
  });

  it("registers a granted install that has no remembered node row when settings opens", async () => {
    const api = apiWith();
    render(<PushPermissionRow plugin={pluginWith("granted")} api={api} />);

    await waitFor(() => expect(api.registerPushDevice).toHaveBeenCalledTimes(1));
    expect(api.registerPushDevice).toHaveBeenCalledWith(
      expect.objectContaining({ install_id: "install-1", token: "token-1" }),
    );
  });

  it("shows the retry when that startup repair fails", async () => {
    const api: NativePushApi = {
      registerPushDevice: vi.fn(async () => {
        throw new Error("offline");
      }),
      deletePushDevice: vi.fn(async () => undefined),
    };
    render(<PushPermissionRow plugin={pluginWith("granted")} api={api} />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Enable notifications" })).toBeTruthy();
  });

  it("asks on a tap, registers this phone, and gets out of the way", async () => {
    const plugin = pluginWith("prompt");
    const api = apiWith();
    render(<PushPermissionRow plugin={plugin} api={api} />);

    const enable = await screen.findByRole("button", { name: "Enable notifications" });
    await userEvent.click(enable);

    await waitFor(() =>
      expect(api.registerPushDevice).toHaveBeenCalledWith(
        expect.objectContaining({ install_id: "install-1", token: "token-1", platform: "ios" }),
      ),
    );
    // Granted means the row has nothing left to say.
    await waitFor(() => expect(screen.queryByRole("button", { name: "Enable notifications" })).toBeNull());
  });

  it("does not prompt a denied phone and points at system settings", async () => {
    const plugin = pluginWith("denied");
    render(<PushPermissionRow plugin={plugin} api={apiWith()} />);

    const open = await screen.findByRole("button", { name: "Open system settings" });
    expect(screen.queryByRole("button", { name: "Enable notifications" })).toBeNull();
    await userEvent.click(open);
    expect(plugin.openSettings).toHaveBeenCalled();
    expect(plugin.requestPermission).not.toHaveBeenCalled();
  });

  it("keeps the row when the grant landed but the node call failed, and repairs on focus", async () => {
    const permission = vi
      .fn()
      .mockResolvedValueOnce({ status: "prompt" })
      .mockResolvedValue({ status: "granted" });
    const registerPushDevice = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue({ id: "device-1" });
    const api: NativePushApi = { registerPushDevice, deletePushDevice: vi.fn(async () => undefined) };
    const plugin = pluginWith("prompt", { permission });
    render(<PushPermissionRow plugin={plugin} api={api} />);

    await userEvent.click(await screen.findByRole("button", { name: "Enable notifications" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    // The permission is now granted; without the failure guard the focus
    // re-read would hide the row and leave the phone silently unregistered.
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Enable notifications" })).toBeNull(),
    );
    expect(registerPushDevice).toHaveBeenCalledTimes(2);
  });

  it("keeps the row when a slow enable fails after a re-read already saw the grant", async () => {
    let rejectRegister: (e: Error) => void = () => {};
    const permission = vi
      .fn()
      .mockResolvedValueOnce({ status: "prompt" })
      .mockResolvedValue({ status: "granted" });
    const plugin = pluginWith("prompt", {
      permission,
      register: vi.fn(
        () => new Promise<never>((_, reject) => {
          rejectRegister = reject;
        }),
      ),
    });
    render(<PushPermissionRow plugin={plugin} api={apiWith()} />);

    await userEvent.click(await screen.findByRole("button", { name: "Enable notifications" }));
    // The permission re-read lands while register() is still in flight, so the
    // page already believes the phone is granted when the call fails.
    window.dispatchEvent(new Event("focus"));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Enable notifications" })).toBeNull(),
    );
    // The row stays while the in-flight registration is still trying; hiding
    // it here would take away the only progress and failure signal.
    expect(await screen.findByRole("button", { name: "Registering…" })).toBeTruthy();
    rejectRegister(new Error("offline"));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
  });

  it("re-reads the permission when the reader comes back from system settings", async () => {
    const permission = vi
      .fn()
      .mockResolvedValueOnce({ status: "denied" })
      .mockResolvedValue({ status: "granted" });
    const plugin = pluginWith("denied", { permission });
    render(<PushPermissionRow plugin={plugin} api={apiWith()} />);

    await screen.findByRole("button", { name: "Open system settings" });
    window.dispatchEvent(new Event("focus"));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Open system settings" })).toBeNull(),
    );
  });
});
