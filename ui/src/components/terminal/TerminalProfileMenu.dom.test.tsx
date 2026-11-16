// @vitest-environment jsdom
import { useRef, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import type { TerminalProfile } from "../../api/client";
import TerminalProfileMenu from "./TerminalProfileMenu";

/**
 * W2: the profile picker is the shared menu, not a private one.
 *
 * What the call site hands over is unchanged — the profiles, the open value and
 * the trigger it borrowed. What is pinned here is that the layer underneath is
 * the console's own: one row per profile, keyboard selection, Escape returning
 * focus to the trigger, and nothing mounted while closed.
 */

const profiles: TerminalProfile[] = [
  { id: "p1", name: "bash", executable: "/bin/bash", default: true },
  { id: "p2", name: "zsh", executable: "/bin/zsh", default: false },
];

/** The caller-owned trigger plus the controlled menu, as TerminalPanel uses it. */
function Host({
  onClose,
  onSelectProfile,
  startOpen = false,
}: {
  onClose?: () => void;
  onSelectProfile?: (profileId: string) => void;
  startOpen?: boolean;
}) {
  const [open, setOpen] = useState(startOpen);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {t("terminal.chooseProfile")}
      </button>
      <TerminalProfileMenu
        profiles={profiles}
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        onSelectProfile={(profileId) => {
          onSelectProfile?.(profileId);
          setOpen(false);
        }}
        anchorRef={triggerRef}
      />
    </div>
  );
}

describe("TerminalProfileMenu", () => {
  it("opens the shared menu with one row per profile and selects by keyboard", async () => {
    const onSelectProfile = vi.fn();
    render(<Host onSelectProfile={onSelectProfile} />);

    await userEvent.click(screen.getByRole("button", { name: t("terminal.chooseProfile") }));
    expect(await screen.findByRole("menu")).toBeTruthy();

    const rows = screen.getAllByRole("menuitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain(profiles[0]!.name);
    // The default profile keeps the suffix it had before the migration.
    expect(rows[0]!.textContent).toContain(t("terminal.defaultProfile"));
    expect(rows[1]!.textContent).toContain(profiles[1]!.name);

    await waitFor(() => expect(document.activeElement).toBe(rows[0]));
    await userEvent.keyboard("{ArrowDown}{Enter}");

    expect(onSelectProfile).toHaveBeenCalledWith("p2");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("closes on Escape and returns focus to the trigger", async () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} startOpen />);

    await screen.findByRole("menu");
    await userEvent.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: t("terminal.chooseProfile") }),
      ),
    );
  });

  it("renders nothing while closed", () => {
    render(<Host />);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryAllByRole("menuitem")).toHaveLength(0);
  });
});
