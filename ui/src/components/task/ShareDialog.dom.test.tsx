// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import ShareDialog from "./ShareDialog";

/**
 * The share dialog, which is the only place a public link to a conversation can
 * be seen. What is pinned here is the one thing the daemon cannot repeat: the
 * URL exists only in the response that minted it, so creating must show it, and
 * revoking must take it away again.
 */
vi.mock("../../api/client", () => ({
  ApiError: class ApiError extends Error {},
  getSessionShare: vi.fn(),
  createSessionShare: vi.fn(),
  revokeSessionShare: vi.fn(),
}));

import { createSessionShare, getSessionShare, revokeSessionShare } from "../../api/client";

const mocked = {
  getSessionShare: vi.mocked(getSessionShare),
  createSessionShare: vi.mocked(createSessionShare),
  revokeSessionShare: vi.mocked(revokeSessionShare),
};

function setup() {
  const onClose = vi.fn();
  render(<ShareDialog open onClose={onClose} taskId="task-1" />);
  return { onClose };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ShareDialog", () => {
  it("offers to create a link when nothing is shared", async () => {
    mocked.getSessionShare.mockResolvedValue({ active: false });
    setup();
    await waitFor(() => expect(screen.getByText(t("task.shareInactive"))).toBeTruthy());
    expect(screen.getByRole("button", { name: t("task.shareCreate") })).toBeTruthy();
  });

  it("shows the minted link, built from the address the console was reached on", async () => {
    mocked.getSessionShare.mockResolvedValue({ active: false });
    mocked.createSessionShare.mockResolvedValue({
      token: "tok-123",
      created_at: 1,
      expires_at: 0,
    });
    setup();
    await waitFor(() => expect(mocked.getSessionShare).toHaveBeenCalledWith("task-1"));
    fireEvent.click(screen.getByRole("button", { name: t("task.shareCreate") }));

    const field = (await screen.findByLabelText(t("task.shareLinkLabel"))) as HTMLInputElement;
    expect(field.value).toBe(`${window.location.origin}/s/tok-123`);
    // The one thing a reader must not miss: the link cannot be shown again.
    expect(screen.getByText(t("task.shareOnlyOnce"))).toBeTruthy();
  });

  it("revokes a live link and stops showing it", async () => {
    mocked.getSessionShare.mockResolvedValue({ active: true, created_at: 5 });
    mocked.revokeSessionShare.mockResolvedValue({ revoked: 1 });
    setup();
    await waitFor(() => expect(screen.getByText(t("task.shareActive"))).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: t("task.shareRevoke") }));
    await waitFor(() => expect(mocked.revokeSessionShare).toHaveBeenCalledWith("task-1"));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: t("task.shareCreate") })).toBeTruthy(),
    );
    expect(screen.queryByLabelText(t("task.shareLinkLabel"))).toBeNull();
  });

  it("closes on Escape", async () => {
    mocked.getSessionShare.mockResolvedValue({ active: false });
    const { onClose } = setup();
    await waitFor(() => expect(mocked.getSessionShare).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  // Moving to another conversation while the dialog is up must not leave the
  // previous conversation's link under the new one's state.
  it("drops the previous task's link when the task changes", async () => {
    mocked.getSessionShare.mockResolvedValue({ active: false });
    mocked.createSessionShare.mockResolvedValue({ token: "tok-1", created_at: 1, expires_at: 0 });
    const onClose = vi.fn();
    const { rerender } = render(<ShareDialog open onClose={onClose} taskId="task-1" />);
    fireEvent.click(await screen.findByRole("button", { name: t("task.shareCreate") }));
    await screen.findByLabelText(t("task.shareLinkLabel"));

    mocked.getSessionShare.mockResolvedValue({ active: false });
    rerender(<ShareDialog open onClose={onClose} taskId="task-2" />);
    await waitFor(() => expect(mocked.getSessionShare).toHaveBeenCalledWith("task-2"));
    expect(screen.queryByLabelText(t("task.shareLinkLabel"))).toBeNull();
  });

  // The link cannot be shown again, so it has to be reachable without a mouse.
  it("focuses the minted link", async () => {
    mocked.getSessionShare.mockResolvedValue({ active: false });
    mocked.createSessionShare.mockResolvedValue({ token: "tok-9", created_at: 1, expires_at: 0 });
    setup();
    fireEvent.click(await screen.findByRole("button", { name: t("task.shareCreate") }));
    const field = (await screen.findByLabelText(t("task.shareLinkLabel"))) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(field));
  });

  // Revoked from another device: the link this dialog is holding is dead.
  it("drops a link the server says is no longer live", async () => {
    mocked.getSessionShare.mockResolvedValue({ active: false });
    mocked.createSessionShare.mockResolvedValue({
      token: "tok-dead",
      created_at: 1,
      expires_at: 0,
    });
    const onClose = vi.fn();
    const { rerender } = render(<ShareDialog open onClose={onClose} taskId="task-1" />);
    fireEvent.click(await screen.findByRole("button", { name: t("task.shareCreate") }));
    await screen.findByLabelText(t("task.shareLinkLabel"));

    // Close and reopen: the server now reports nothing live.
    rerender(<ShareDialog open={false} onClose={onClose} taskId="task-1" />);
    mocked.getSessionShare.mockResolvedValue({ active: false });
    rerender(<ShareDialog open onClose={onClose} taskId="task-1" />);
    await waitFor(() => expect(screen.getByText(t("task.shareInactive"))).toBeTruthy());
    expect(screen.queryByLabelText(t("task.shareLinkLabel"))).toBeNull();
  });
});
