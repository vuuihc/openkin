// @vitest-environment jsdom
import { useRef, useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Dialog from "./Dialog";

/**
 * F5c: the desktop modal the conversation and settings migrations consume.
 * It owns the native <dialog> layer, per-purpose dismissal, Tab containment,
 * focus return and the IME guard. History entries, swipe dismissal and the
 * bottom-sheet shape stay with the phone `Sheet` (F5c2 re-bases that).
 */

/*
 * jsdom renders <dialog> but implements neither showModal() nor the top
 * layer, so the local stand-in tracks the open attribute and the close event.
 * jsdom also ships no `CSS` global, which Astryx uses to find its title id.
 */
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
}
if (!HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
}
if (typeof globalThis.CSS === "undefined") {
  (globalThis as { CSS?: Pick<typeof CSS, "escape"> }).CSS = {
    escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&"),
  };
}

const LABEL = "Session settings";

function Host({
  startOpen = true,
  purpose = "info",
  footer,
  children,
  onOpenChange = vi.fn(),
}: {
  startOpen?: boolean;
  purpose?: "info" | "form" | "required";
  footer?: ReactNode;
  children?: ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(startOpen);
  const change = (next: boolean) => {
    onOpenChange(next);
    setOpen(next);
  };
  return (
    <div>
      <button type="button">Outside</button>
      <Dialog open={open} onOpenChange={change} label={LABEL} purpose={purpose} footer={footer}>
        {children ?? <p>Body copy</p>}
      </Dialog>
    </div>
  );
}

/**
 * The opener and a distinct post-close target. Focus lands on "After close"
 * only if the facade honours finalFocusRef; Astryx alone would return it to
 * the opener.
 */
function ClosingHost({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const afterRef = useRef<HTMLButtonElement>(null);
  const change = (next: boolean) => {
    onOpenChange(next);
    setOpen(next);
  };
  return (
    <div>
      <button type="button" onClick={() => change(true)}>
        Open settings
      </button>
      <button type="button" ref={afterRef}>
        After close
      </button>
      <Dialog open={open} onOpenChange={change} label={LABEL} finalFocusRef={afterRef}>
        <button type="button">Body action</button>
      </Dialog>
    </div>
  );
}

const dialog = () => screen.getByRole("dialog", { name: LABEL });

/** A backdrop press: the target is the <dialog> itself on both ends. */
function pressBackdrop(modal: HTMLElement) {
  fireEvent.pointerDown(modal);
  fireEvent.pointerUp(modal);
  fireEvent.click(modal);
}

beforeEach(() => {
  // jsdom has no matchMedia; a fine pointer is the desktop shape here.
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

describe("the Dialog facade", () => {
  it("opens a modal dialog named by its label", () => {
    render(<Host />);
    const modal = dialog();
    expect(modal.tagName).toBe("DIALOG");
    expect(modal.getAttribute("aria-modal")).toBe("true");
    expect(within(modal).getByText("Body copy")).not.toBeNull();
  });

  it("Escape asks to close and returns focus to the finalFocusRef element", async () => {
    const onOpenChange = vi.fn();
    render(<ClosingHost onOpenChange={onOpenChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Open settings" }));
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));

    onOpenChange.mockClear();
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);

    const after = screen.getByRole("button", { name: "After close" });
    await waitFor(() => expect(document.activeElement).toBe(after));
  });

  it("an info dialog closes on a backdrop click", () => {
    const onOpenChange = vi.fn();
    render(<Host purpose="info" onOpenChange={onOpenChange} />);
    // The positive control for the two negative backdrop tests below.
    pressBackdrop(dialog());
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a form dialog keeps Escape but ignores a backdrop click", async () => {
    const onOpenChange = vi.fn();
    render(<Host purpose="form" onOpenChange={onOpenChange} />);

    pressBackdrop(dialog());
    expect(onOpenChange).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("a required dialog ignores Escape and backdrop", async () => {
    const onOpenChange = vi.fn();
    render(<Host purpose="required" onOpenChange={onOpenChange} />);
    // A mandatory flow is an alert dialog; the layer behavior is the subject.
    const modal = screen.getByRole("alertdialog", { name: LABEL });
    pressBackdrop(modal);
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("Tab stays inside the dialog", async () => {
    render(
      <Host purpose="required">
        <button type="button">First action</button>
        <button type="button">Last action</button>
      </Host>,
    );
    const modal = screen.getByRole("alertdialog", { name: LABEL });
    const first = within(modal).getByRole("button", { name: "First action" });
    const last = within(modal).getByRole("button", { name: "Last action" });

    last.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(first);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(last);
  });

  it("an IME composition's Escape does not close", () => {
    const onOpenChange = vi.fn();
    render(<Host onOpenChange={onOpenChange} />);
    const modal = dialog();
    fireEvent.keyDown(modal, { key: "Escape", isComposing: true });
    // Some IMEs and older Safari report the composing key only as keyCode 229.
    fireEvent.keyDown(modal, { key: "Escape", keyCode: 229 });
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("the footer renders inside the dialog and the close control is reachable by keyboard", () => {
    render(<Host footer={<button type="button">Save</button>} />);
    const modal = dialog();
    expect(modal.contains(within(modal).getByRole("button", { name: "Save" }))).toBe(true);

    const close = within(modal).getByRole("button", { name: /close/i });
    expect((close as HTMLButtonElement).disabled).toBe(false);
    expect((close as HTMLButtonElement).tabIndex).toBe(0);
    // jsdom lays nothing out, so Astryx's coarse-pointer hit band is the
    // observable form of its 44px touch floor. The band also proves this is
    // Astryx's own control rather than a bare icon.
    expect(close.innerHTML).toContain("x1fjtqre");
  });

  it("unmounting an open dialog leaves no stray dialog element", () => {
    const { unmount } = render(<Host />);
    expect(dialog()).not.toBeNull();
    unmount();
    expect(document.querySelector("dialog")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
