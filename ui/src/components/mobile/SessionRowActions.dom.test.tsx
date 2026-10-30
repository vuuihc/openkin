// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { t } from "../../i18n";
import SessionRowActions from "./SessionRowActions";

/**
 * What a phone row uncovers. The contract the list depends on: three actions,
 * each one named for a screen reader and each wired to its own handler. Delete
 * is the one that cannot be undone, so its visible label carries the meaning —
 * the danger colour is a second signal, never the only one.
 */
describe("SessionRowActions", () => {
  it("calls the handler that belongs to the chip that was tapped", () => {
    const onPin = vi.fn();
    const onArchive = vi.fn();
    const onDelete = vi.fn();
    render(<SessionRowActions onPin={onPin} onArchive={onArchive} onDelete={onDelete} />);

    fireEvent.click(screen.getByRole("button", { name: t("sessions.pin") }));
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onArchive).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: t("sessions.archive") }));
    expect(onArchive).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: t("sessions.delete") }));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it("writes 'delete' on the delete chip, not only paints it red", () => {
    render(<SessionRowActions onPin={vi.fn()} onArchive={vi.fn()} onDelete={vi.fn()} />);
    const remove = screen.getByRole("button", { name: t("sessions.delete") });
    expect(remove.textContent).toBe(t("sessions.delete"));
    expect(remove.className).toContain("text-kin-red-ink");
  });

  it("offers 'unpin' on a row that is already pinned", () => {
    // The batch toolbar already flips its label; a pinned row whose chip still
    // said "Pin" would name the opposite of what tapping it does.
    const onPin = vi.fn();
    render(<SessionRowActions pinned onPin={onPin} onArchive={vi.fn()} onDelete={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: t("sessions.unpin") }));
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: t("sessions.pin") })).toBeNull();
  });
});
