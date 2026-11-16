// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { t } from "../../i18n";
import type { ExternalApp } from "../../lib/desktop";
import OpenInMenu from "./OpenInMenu";

/**
 * The desktop "Open in…" control moved onto the console's shared facade.
 *
 * What this pins is the menu contract, not the markup: the trigger is the
 * button with the same name it always had, the application list is a shared
 * `role="menu"` layer, choosing a row calls the desktop bridge once and hands
 * focus back to the trigger, and the loading/empty states are inert rows
 * rather than prose the keyboard cannot reach.
 */

const desktop = vi.hoisted(() => ({
  isKinDesktop: vi.fn(() => true),
  listExternalApps: vi.fn(),
  openInExternalApp: vi.fn(),
}));

vi.mock("../../lib/desktop", async () => {
  const actual = await vi.importActual<typeof import("../../lib/desktop")>("../../lib/desktop");
  return {
    ...actual,
    isKinDesktop: desktop.isKinDesktop,
    listExternalApps: desktop.listExternalApps,
    openInExternalApp: desktop.openInExternalApp,
  };
});

const ROOT = "/tmp/ws";
const trigger = () => screen.getByRole("button", { name: t("workspace.openWith.button") });

beforeEach(() => {
  desktop.isKinDesktop.mockReset().mockReturnValue(true);
  desktop.listExternalApps.mockReset().mockResolvedValue([]);
  desktop.openInExternalApp.mockReset().mockResolvedValue({ ok: true });
});

describe("the open-in menu", () => {
  it("opens the application list as a shared menu and returns focus to its trigger", async () => {
    desktop.listExternalApps.mockResolvedValue([
      { id: "finder", label: "Finder", labelKey: "finder" } satisfies ExternalApp,
    ]);

    render(<OpenInMenu root={ROOT} relativePath="src/a.ts" />);
    await userEvent.click(trigger());

    const menu = await screen.findByRole("menu", { name: t("workspace.openWith.button") });
    expect(menu).toBeTruthy();
    const finder = await screen.findByRole("menuitem", { name: "Finder" });

    // Rows that arrive after the panel opened still take focus: the menu is
    // keyboard-operable from the first real row, not only after a Tab.
    await waitFor(() => expect(document.activeElement).toBe(finder));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(finder);
    await userEvent.keyboard("{Enter}");

    expect(desktop.openInExternalApp).toHaveBeenCalledTimes(1);
    expect(desktop.openInExternalApp).toHaveBeenCalledWith("/tmp/ws/src/a.ts", "finder");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger());
  });

  it("shows the detecting row as a disabled menu item and the empty state as one", async () => {
    let resolveApps: (apps: ExternalApp[]) => void = () => {};
    desktop.listExternalApps.mockImplementation(
      () => new Promise<ExternalApp[]>((resolve) => (resolveApps = resolve)),
    );

    render(<OpenInMenu root={ROOT} relativePath="src/a.ts" />);
    await userEvent.click(trigger());

    const detecting = await screen.findByRole("menuitem", {
      name: t("workspace.openWith.detecting"),
    });
    expect(detecting.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      resolveApps([]);
    });

    const none = await screen.findByRole("menuitem", { name: t("workspace.openWith.none") });
    expect(none.getAttribute("aria-disabled")).toBe("true");
    expect(screen.queryByRole("menuitem", { name: t("workspace.openWith.detecting") })).toBeNull();

    // The shared layer owns the dismissal: one Escape closes it.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("keeps the application rows after a failed open and reaches the bridge again", async () => {
    desktop.listExternalApps.mockResolvedValue([
      { id: "finder", label: "Finder", labelKey: "finder" } satisfies ExternalApp,
    ]);
    desktop.openInExternalApp
      .mockResolvedValueOnce({ ok: false, error: "bridge-unavailable" })
      .mockResolvedValueOnce({ ok: true });

    render(<OpenInMenu root={ROOT} relativePath="src/a.ts" />);
    await userEvent.click(trigger());
    await userEvent.click(await screen.findByRole("menuitem", { name: "Finder" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    // Reopening after the refusal still offers the apps: the error is a note
    // above the rows, not a replacement for them.
    await userEvent.click(trigger());
    const error = await screen.findByRole("menuitem", { name: "bridge-unavailable" });
    expect(error.getAttribute("aria-disabled")).toBe("true");
    const finder = screen.getByRole("menuitem", { name: "Finder" });
    expect(finder.getAttribute("aria-disabled")).not.toBe("true");

    await userEvent.click(finder);

    await waitFor(() => expect(desktop.openInExternalApp).toHaveBeenCalledTimes(2));
    expect(desktop.openInExternalApp).toHaveBeenLastCalledWith("/tmp/ws/src/a.ts", "finder");
  });
});
