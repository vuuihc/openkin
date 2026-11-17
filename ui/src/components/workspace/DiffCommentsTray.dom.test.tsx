// @vitest-environment jsdom
// KIN-RESULT-003 — the per-conversation tray of diff comments: review, jump,
// delete, and send the whole set back as one ordinary follow-up message.
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { t } from "../../i18n";
import { AstryxProvider } from "../../design/AstryxProvider";
import type { DiffComment } from "./diffCommentAnchor";
import DiffCommentsTray from "./DiffCommentsTray";

function comment(overrides: Partial<DiffComment> = {}): DiffComment {
  return {
    id: "dc_1",
    path: "src/settings.ts",
    hunkHeader: "@@ -10,3 +10,4 @@",
    quote: "const title = settings.title;",
    line: 11,
    text: "This should fall back to the default title.",
    createdAt: 1,
    ...overrides,
  };
}

const THREE = [
  comment(),
  comment({
    id: "dc_2",
    path: "src/other.ts",
    hunkHeader: "@@ -1,2 +1,2 @@",
    quote: "return a + b;",
    line: 3,
    text: "a + b can overflow here.",
  }),
  comment({
    id: "dc_3",
    path: "src/third.ts",
    hunkHeader: "@@ -5,0 +6,1 @@",
    quote: "// added",
    line: 6,
    text: "This comment is unnecessary.",
  }),
];

/**
 * The tray is controlled: the page owns the comments. This harness is the
 * page's smallest honest stand-in — deletion removes the row, a successful
 * send clears the list, a failed send leaves it alone.
 */
function Harness({
  initial,
  onJump = vi.fn(),
  onClose = vi.fn(),
  onSend = vi.fn(() => Promise.resolve()),
}: {
  initial: DiffComment[];
  onJump?: (value: DiffComment) => void;
  onClose?: () => void;
  onSend?: () => Promise<void>;
}) {
  const [comments, setComments] = useState(initial);
  return (
    <AstryxProvider>
      <div data-testid="diff-surface" tabIndex={-1} />
      <DiffCommentsTray
        comments={comments}
        onJump={onJump}
        onDelete={(id) => setComments((current) => current.filter((item) => item.id !== id))}
        onSend={async () => {
          await onSend();
          setComments([]);
        }}
        onClose={onClose}
        returnFocus={() => screen.getByTestId("diff-surface").focus()}
      />
    </AstryxProvider>
  );
}

const jumpButton = (path: string, line: number) =>
  screen.getByRole("button", { name: t("workspace.comments.jumpToRow", { path, line }) });

describe("the diff comments tray", () => {
  it("lists saved comments with path, quote and text", () => {
    render(<Harness initial={THREE} />);

    for (const item of THREE) {
      expect(screen.getByText(`${item.path}:${item.line}`)).toBeTruthy();
      expect(screen.getByText(item.quote)).toBeTruthy();
      expect(screen.getByText(item.text)).toBeTruthy();
    }
    // The count is visible on the send action, so "3 comments" is one glance.
    expect(
      screen.getByRole("button", { name: t("workspace.comments.send", { count: 3 }) }),
    ).toBeTruthy();
  });

  it("jumps to the anchored line when a row is activated", () => {
    const onJump = vi.fn();
    render(<Harness initial={THREE} onJump={onJump} />);

    fireEvent.click(jumpButton("src/other.ts", 3));

    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump.mock.calls[0]?.[0]).toMatchObject({ id: "dc_2", line: 3 });
  });

  it("deletes a comment and keeps focus on the next row", async () => {
    render(<Harness initial={THREE} />);

    fireEvent.click(jumpButton("src/settings.ts", 11));
    const deleteFirst = screen.getByRole("button", {
      name: t("workspace.comments.deleteRow", { path: "src/settings.ts", line: 11 }),
    });
    fireEvent.click(deleteFirst);

    // The row is gone and the next one took the focus — not `<body>`.
    expect(screen.queryByText("src/settings.ts:11")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(jumpButton("src/other.ts", 3)));
  });

  it("renders nothing when the conversation has no comments", () => {
    const { container } = render(<Harness initial={[]} />);
    expect(container.querySelector("section")).toBeNull();
    expect(
      screen.queryByRole("button", { name: t("workspace.comments.send", { count: 0 }) }),
    ).toBeNull();
  });

  it("sends every comment as one follow-up and clears the tray", async () => {
    const onSend = vi.fn(() => Promise.resolve());
    render(<Harness initial={THREE} onSend={onSend} />);

    fireEvent.click(
      screen.getByRole("button", { name: t("workspace.comments.send", { count: 3 }) }),
    );

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    // One call, not one per comment: the page turns the tray into a single
    // ordinary message. Then the list is empty and the person is told.
    await waitFor(() => expect(screen.queryByText("src/settings.ts:11")).toBeNull());
    expect(await screen.findByText(t("workspace.comments.sent"))).toBeTruthy();
  });

  it("keeps the comments when the send fails", async () => {
    const onSend = vi.fn(() => Promise.reject(new Error("offline")));
    render(<Harness initial={THREE} onSend={onSend} />);

    const send = screen.getByRole("button", { name: t("workspace.comments.send", { count: 3 }) });
    fireEvent.click(send);

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    // Nothing was cleared, the reason is on the tray's own surface, and the
    // button is usable again for a retry.
    expect(screen.getByText("src/settings.ts:11")).toBeTruthy();
    expect(await screen.findByText(t("workspace.comments.sendFailed"))).toBeTruthy();
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
  });

  it("closes on Esc and hands focus back to the diff", () => {
    const onClose = vi.fn();
    render(<Harness initial={THREE} onClose={onClose} />);

    const send = screen.getByRole("button", { name: t("workspace.comments.send", { count: 3 }) });
    send.focus();
    fireEvent.keyDown(send, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByTestId("diff-surface"));
  });
});
