// @vitest-environment jsdom
// KIN-RESULT-003 — the per-conversation tray of diff comments: review, jump,
// delete, and send the whole set back as one ordinary follow-up message.
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { t } from "../../i18n";
import { AstryxProvider } from "../../design/AstryxProvider";
import type { CommentAnchorState, DiffComment } from "./diffCommentAnchor";
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
 * page's smallest honest stand-in — deletion removes the row and leaves an
 * undo slot, a restore puts the comment back where it was, editing rewrites
 * only the words, a successful send clears both the list and the undo, and a
 * failed send leaves everything alone.
 */
function Harness({
  initial,
  anchors,
  onJump = vi.fn(),
  onClose = vi.fn(),
  onSend = vi.fn(() => Promise.resolve()),
  onEdit = vi.fn(),
  onRestore = vi.fn(),
}: {
  initial: DiffComment[];
  anchors?: Record<string, CommentAnchorState>;
  onJump?: (value: DiffComment) => void;
  onClose?: () => void;
  onSend?: () => Promise<void>;
  onEdit?: (id: string, text: string) => void;
  onRestore?: (comment: DiffComment, index: number) => void;
}) {
  const [comments, setComments] = useState(initial);
  const [undo, setUndo] = useState<{ comment: DiffComment; index: number } | null>(null);
  return (
    <AstryxProvider>
      <div data-testid="diff-surface" tabIndex={-1} />
      <DiffCommentsTray
        comments={comments}
        anchors={anchors}
        undo={undo}
        onJump={onJump}
        onDelete={(id) => {
          const index = comments.findIndex((item) => item.id === id);
          const deleted = comments[index];
          if (!deleted) return;
          setUndo({ comment: deleted, index });
          setComments((current) => current.filter((item) => item.id !== id));
        }}
        onRestore={(comment, index) => {
          onRestore(comment, index);
          setComments((current) => [...current.slice(0, index), comment, ...current.slice(index)]);
          setUndo(null);
        }}
        onEdit={(id, text) => {
          onEdit(id, text);
          setComments((current) =>
            current.map((item) => (item.id === id ? { ...item, text } : item)),
          );
        }}
        onSend={async () => {
          await onSend();
          setComments([]);
          setUndo(null);
        }}
        onClose={onClose}
        returnFocus={() => screen.getByTestId("diff-surface").focus()}
      />
    </AstryxProvider>
  );
}

const jumpButton = (path: string, line: number) =>
  screen.getByRole("button", { name: t("workspace.comments.jumpToRow", { path, line }) });

const deleteButton = (path: string, line: number) =>
  screen.getByRole("button", { name: t("workspace.comments.deleteRow", { path, line }) });

const editButton = (path: string, line: number) =>
  screen.getByRole("button", { name: t("workspace.comments.editRow", { path, line }) });

/** The tray's one-line undo action; there is never more than one. */
const undoButton = () => screen.getByRole("button", { name: t("workspace.comments.undo") });

const sendButton = (count: number) =>
  screen.getByRole("button", { name: t("workspace.comments.send", { count }) });

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

  it("stacks a row's path, quote and text in one column", () => {
    render(<Harness initial={THREE} />);

    // jsdom has no layout, so the class is the pin: the three lines live in
    // our own column wrapper, not directly under Astryx's row-direction label
    // span, which would lay them out sideways and under the Delete button.
    const row = jumpButton("src/settings.ts", 11);
    const stack = row.querySelector("span.flex-col");
    expect(stack).toBeTruthy();
    expect(stack?.children).toHaveLength(3);
    expect(stack?.className).toContain("w-full");
    expect(stack?.className).toContain("min-w-0");
    // The facade's fixed 44px height is a touch floor, not a cap: a three-line
    // row that cannot grow overflows its own button and its comment text is
    // clipped at the bottom of the pane.
    expect(row.className).toContain("h-auto!");
    expect(row.className).toContain("min-h-11");
  });

  it("keeps its own height so the diff above yields, not its rows", () => {
    render(<Harness initial={THREE} />);

    // jsdom has no layout, so the class is the pin: a shrinkable tray lost the
    // height argument with the editor and clipped its first row at the pane's
    // bottom edge instead of showing it.
    const tray = screen.getByRole("region", { name: t("workspace.comments.trayTitle") });
    expect(tray.className).toContain("flex-none");
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

  it("marks a stale row 该行已变化, keeps its hunk header and quote, and still deletes", () => {
    const anchors: Record<string, CommentAnchorState> = {
      dc_1: { line: 11, stale: true },
    };
    render(<Harness initial={[comment()]} anchors={anchors} />);

    // The accessible name carries the failure state, so it is not colour-only.
    const row = screen.getByRole("button", {
      name: t("workspace.comments.staleRow", { path: "src/settings.ts", line: 11 }),
    });
    expect(
      screen.queryByRole("button", {
        name: t("workspace.comments.jumpToRow", { path: "src/settings.ts", line: 11 }),
      }),
    ).toBeNull();

    // The badge, the original hunk header and the quote all survive: the row
    // still says where the comment was written.
    expect(screen.getByText(t("workspace.comments.stale"))).toBeTruthy();
    expect(screen.getByText("@@ -10,3 +10,4 @@")).toBeTruthy();
    expect(screen.getByText("const title = settings.title;")).toBeTruthy();
    // A stale row is a note, not a disabled row: it still deletes.
    expect(row).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: t("workspace.comments.deleteRow", { path: "src/settings.ts", line: 11 }),
      }),
    );
    expect(screen.queryByText("src/settings.ts:11")).toBeNull();
  });

  it("shows the re-anchored line on a live row and jumps to it", () => {
    const anchors: Record<string, CommentAnchorState> = {
      dc_1: { line: 21, stale: false },
    };
    // The panel resolves the jump line exactly this way; the tray only shows
    // the state the panel hands it.
    const resolve = (item: DiffComment) => anchors[item.id]?.line ?? item.line;
    const onJump = vi.fn((item: DiffComment) => ({ id: item.id, line: resolve(item) }));
    render(<Harness initial={[comment()]} anchors={anchors} onJump={onJump} />);

    // The saved line was 11; the row reads the re-anchored line.
    expect(screen.getByText("src/settings.ts:21")).toBeTruthy();
    expect(screen.queryByText("src/settings.ts:11")).toBeNull();
    // A live row is never implied stale.
    expect(screen.queryByText(t("workspace.comments.stale"))).toBeNull();

    fireEvent.click(jumpButton("src/settings.ts", 21));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump.mock.results[0]?.value).toEqual({ id: "dc_1", line: 21 });
  });

  // ——— KIN-RESULT-003 §4 键盘 / §6 改一条、删一条 ———

  it("sends the whole tray with ⌘/Ctrl+Enter and returns focus to the diff", async () => {
    // Both Mac's ⌘ and the Ctrl other keyboards use: one handler, no fork.
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }]) {
      const onSend = vi.fn(() => Promise.resolve());
      const view = render(<Harness initial={THREE} onSend={onSend} />);

      const row = jumpButton("src/other.ts", 3);
      row.focus();
      fireEvent.keyDown(row, { key: "Enter", ...modifier });

      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
      // The tray clears, and the keyboard is back where the review continues.
      await waitFor(() => expect(screen.queryByText("src/other.ts:3")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("diff-surface")));
      view.unmount();
    }
  });

  it("does not return focus when the ⌘Enter send fails", async () => {
    const onSend = vi.fn(() => Promise.reject(new Error("offline")));
    render(<Harness initial={THREE} onSend={onSend} />);

    const row = jumpButton("src/settings.ts", 11);
    row.focus();
    fireEvent.keyDown(row, { key: "Enter", metaKey: true });

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));
    // The comments stay, the failure is named, and focus stays in the tray so
    // the person can retry — a failed send must not dump them into the diff.
    expect(await screen.findByText(t("workspace.comments.sendFailed"))).toBeTruthy();
    expect(screen.getByText("src/settings.ts:11")).toBeTruthy();
    expect(document.activeElement).toBe(row);
  });

  it("does not send on plain Enter; a row still jumps", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    const onSend = vi.fn(() => Promise.resolve());
    render(<Harness initial={THREE} onJump={onJump} onSend={onSend} />);

    const row = jumpButton("src/other.ts", 3);
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();

    // The row's own activation is untouched: Enter on a focused button still
    // opens the line it names.
    await user.keyboard("{Enter}");
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump.mock.calls[0]?.[0]).toMatchObject({ id: "dc_2" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("edits a comment in place without moving its anchor or changing the count", () => {
    const onEdit = vi.fn();
    const onSend = vi.fn(() => Promise.resolve());
    render(<Harness initial={THREE} onEdit={onEdit} onSend={onSend} />);

    fireEvent.click(editButton("src/other.ts", 3));
    const field = screen.getByRole("textbox", {
      name: t("workspace.comments.fieldLabel"),
    }) as HTMLTextAreaElement;
    expect(field.value).toBe("a + b can overflow here.");

    fireEvent.change(field, { target: { value: "a + b overflows on 32-bit." } });
    fireEvent.keyDown(field, { key: "Enter", metaKey: true });

    // ⌘Enter in the editor saves the words; it does not send the whole tray.
    expect(onSend).not.toHaveBeenCalled();
    expect(onEdit).toHaveBeenCalledWith("dc_2", "a + b overflows on 32-bit.");
    expect(screen.getByText("a + b overflows on 32-bit.")).toBeTruthy();
    // The anchor is untouched and the set is still three comments.
    expect(jumpButton("src/other.ts", 3)).toBeTruthy();
    expect(sendButton(3)).toBeTruthy();

    // The button path saves the same way.
    fireEvent.click(editButton("src/settings.ts", 11));
    const second = screen.getByRole("textbox", {
      name: t("workspace.comments.fieldLabel"),
    });
    fireEvent.change(second, { target: { value: "Fall back to the default title." } });
    fireEvent.click(screen.getByRole("button", { name: t("workspace.comments.save") }));

    expect(onEdit).toHaveBeenCalledWith("dc_1", "Fall back to the default title.");
    expect(onEdit).toHaveBeenCalledTimes(2);
    expect(jumpButton("src/settings.ts", 11)).toBeTruthy();
  });

  it("rejects an empty edit and keeps the original words on Esc", () => {
    const onEdit = vi.fn();
    render(<Harness initial={[comment()]} onEdit={onEdit} />);

    fireEvent.click(editButton("src/settings.ts", 11));
    const field = screen.getByRole("textbox", { name: t("workspace.comments.fieldLabel") });

    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: t("workspace.comments.save") }));
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByText(t("workspace.comments.empty"))).toBeTruthy();

    // Esc leaves the editor without saving and without closing the tray.
    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.queryByText(t("workspace.comments.empty"))).toBeNull();
    expect(screen.getByText("This should fall back to the default title.")).toBeTruthy();
    expect(document.activeElement).toBe(jumpButton("src/settings.ts", 11));
  });

  it("keeps the editor's own keys when focus is on its actions", () => {
    const onEdit = vi.fn();
    const onSend = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();
    render(<Harness initial={[comment()]} onEdit={onEdit} onSend={onSend} onClose={onClose} />);

    fireEvent.click(editButton("src/settings.ts", 11));
    const field = screen.getByRole("textbox", { name: t("workspace.comments.fieldLabel") });
    fireEvent.change(field, { target: { value: "Use the default title instead." } });

    // ⌘Enter on the editor's own Save is the editor's key, not the tray's:
    // it saves the draft and sends nothing.
    const save = screen.getByRole("button", { name: t("workspace.comments.save") });
    save.focus();
    fireEvent.keyDown(save, { key: "Enter", metaKey: true });
    expect(onSend).not.toHaveBeenCalled();
    expect(onEdit).toHaveBeenCalledWith("dc_1", "Use the default title instead.");
    expect(screen.getByText("Use the default title instead.")).toBeTruthy();

    // Esc on Cancel closes the editor, not the tray.
    fireEvent.click(editButton("src/settings.ts", 11));
    const cancel = screen.getByRole("button", { name: t("workspace.comments.cancel") });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: t("workspace.comments.trayTitle") })).toBeTruthy();
    expect(screen.getByText("Use the default title instead.")).toBeTruthy();
  });

  it("undoes a delete at the original position", async () => {
    const onRestore = vi.fn();
    render(<Harness initial={THREE} onRestore={onRestore} />);

    fireEvent.click(deleteButton("src/other.ts", 3));
    expect(screen.queryByText("src/other.ts:3")).toBeNull();
    expect(screen.getByText(t("workspace.comments.deleted"))).toBeTruthy();

    fireEvent.click(undoButton());

    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onRestore).toHaveBeenCalledWith(THREE[1], 1);
    // Back between its neighbours, not appended to the end.
    const rows = screen.getAllByRole("listitem").map((row) => row.textContent ?? "");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("src/settings.ts:11");
    expect(rows[1]).toContain("src/other.ts:3");
    expect(rows[2]).toContain("src/third.ts:6");
    expect(sendButton(3)).toBeTruthy();
    // Focus lands on the row that came back, ready for ↑/↓.
    await waitFor(() => expect(document.activeElement).toBe(jumpButton("src/other.ts", 3)));
  });

  it("keeps a one-line undo after the last delete and gives focus back to the diff", async () => {
    render(<Harness initial={[comment()]} />);

    fireEvent.click(deleteButton("src/settings.ts", 11));

    // No empty panel: the tray region is gone, one line remains.
    expect(screen.queryByRole("region", { name: t("workspace.comments.trayTitle") })).toBeNull();
    expect(screen.getByText(t("workspace.comments.deleted"))).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("diff-surface")));

    // Undo brings the tray back with the row it lost.
    fireEvent.click(undoButton());
    expect(screen.getByRole("region", { name: t("workspace.comments.trayTitle") })).toBeTruthy();
    expect(jumpButton("src/settings.ts", 11)).toBeTruthy();
  });

  it("clears the undo when the remaining comments are sent", async () => {
    const onSend = vi.fn(() => Promise.resolve());
    render(<Harness initial={THREE} onSend={onSend} />);

    fireEvent.click(deleteButton("src/other.ts", 3));
    expect(screen.getByText(t("workspace.comments.deleted"))).toBeTruthy();

    fireEvent.click(sendButton(2));
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1));

    // A sent set cannot be resurrected by an undo that outlived it.
    await waitFor(() => expect(screen.queryByText(t("workspace.comments.deleted"))).toBeNull());
    expect(screen.queryByRole("button", { name: t("workspace.comments.undo") })).toBeNull();
    expect(await screen.findByText(t("workspace.comments.sent"))).toBeTruthy();
  });
});
