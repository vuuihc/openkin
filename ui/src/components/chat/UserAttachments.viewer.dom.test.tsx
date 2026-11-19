// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import UserAttachments from "./UserAttachments";

/**
 * Sent pictures open the same viewer as composer thumbnails. The modal and its
 * Escape/focus contract are `Sheet`'s; these tests pin that the picture is a
 * named control and that a broken picture does not become one.
 */

beforeEach(() => {
  setLocale("en");
  window.history.replaceState({ idx: 0 }, "", "/tasks/t1");
});

describe("sent image viewer", () => {
  it("opens the shared viewer from a sent image", async () => {
    const user = userEvent.setup();
    render(<UserAttachments images={[{ name: "shot.png", src: "/api/uploads/abc.png" }]} />);

    await user.click(screen.getByRole("button", { name: "View shot.png" }));

    const dialog = await screen.findByRole("dialog", { name: "shot.png" });
    const image = within(dialog).getByRole("img", { name: "shot.png" });
    expect(image.getAttribute("src")).toBe("/api/uploads/abc.png");
  });

  it("Escape closes the viewer and focus returns to the thumbnail", async () => {
    const user = userEvent.setup();
    render(<UserAttachments images={[{ name: "shot.png", src: "/api/uploads/abc.png" }]} />);
    const thumb = screen.getByRole("button", { name: "View shot.png" });

    await user.click(thumb);
    await screen.findByRole("dialog", { name: "shot.png" });

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(thumb);
  });

  it("a failed image stays a filename chip, not a button", () => {
    render(<UserAttachments images={[{ name: "gone.png", src: "/api/uploads/gone.png" }]} />);

    fireEvent.error(screen.getByRole("img", { name: "gone.png" }));

    expect(screen.getByTestId("user-attachment-chip").textContent).toBe("gone.png");
    expect(screen.queryByRole("button", { name: /gone\.png/ })).toBeNull();
    expect(screen.queryByRole("img", { name: "gone.png" })).toBeNull();
  });
});
