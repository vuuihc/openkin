// @vitest-environment jsdom
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Popover, { type PopoverProps } from "./Popover";

/**
 * Q3a: the anchored popover the Composer migration will consume.
 *
 * The trigger keeps owning its own `aria-expanded` / `aria-controls`; this
 * primitive owns only what is generic: a body portal measured from the
 * viewport, outside-pointer and Escape dismissal, focus moving into the panel
 * once it has actually been measured (LESSONS: "弹出层的焦点要等它真的挂载"),
 * focus returning to the trigger on Escape, containment while it is a dialog,
 * and no document handlers left behind after it closes.
 *
 * Menu arrow-key semantics are deliberately absent: they belong to the menu
 * that Q3b builds on top, not to this container.
 */

const PANEL_ID = "q3a-panel";

type HostProps = {
  onOpenChange?: (open: boolean) => void;
  startOpen?: boolean;
  children?: ReactNode;
  triggerRef?: RefObject<HTMLButtonElement>;
} & Pick<PopoverProps, "placement" | "align" | "width" | "maxWidth" | "maxHeight">;

function Host({
  onOpenChange = vi.fn(),
  startOpen = false,
  children,
  triggerRef: suppliedRef,
  ...placement
}: HostProps) {
  const [open, setOpen] = useState(startOpen);
  const ownRef = useRef<HTMLButtonElement>(null);
  const triggerRef = suppliedRef ?? ownRef;
  const change = (next: boolean) => {
    onOpenChange(next);
    setOpen(next);
  };
  return (
    <div>
      <div data-testid="toolbar">
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          aria-controls={PANEL_ID}
          onClick={() => change(!open)}
        >
          Filters
        </button>
      </div>
      <button type="button">Outside</button>
      <Popover
        id={PANEL_ID}
        open={open}
        onOpenChange={change}
        triggerRef={triggerRef}
        label="Filters"
        {...placement}
      >
        {children ?? <button type="button">Apply</button>}
      </Popover>
    </div>
  );
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: height });
}

const trigger = () => screen.getByRole("button", { name: "Filters" });

beforeEach(() => {
  setViewport(1280, 800);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the anchored popover", () => {
  it("opens an anchored body portal without changing the trigger's layout footprint", async () => {
    setViewport(390, 844);
    vi.spyOn(HTMLButtonElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 300,
      top: 300,
      bottom: 340,
      left: 20,
      right: 120,
      width: 100,
      height: 40,
      toJSON: () => ({}),
    });

    render(<Host width={240} />);
    const toolbar = screen.getByTestId("toolbar");
    expect(toolbar.childElementCount).toBe(1);
    const before = trigger().getBoundingClientRect();

    await userEvent.click(trigger());

    const dialog = screen.getByRole("dialog", { name: "Filters" });
    // The panel is a child of <body>, so no `overflow-*` strip between the
    // trigger and the page can clip it.
    expect(dialog.parentElement).toBe(document.body);
    expect(toolbar.childElementCount).toBe(1);
    expect(trigger().getBoundingClientRect()).toEqual(before);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(PANEL_ID);
  });

  it("focuses content after measurement and returns focus to the trigger on Escape", async () => {
    const onOpenChange = vi.fn();
    render(<Host startOpen onOpenChange={onOpenChange} />);

    const apply = screen.getByRole("button", { name: "Apply" });
    // The panel is portaled only once the anchor has been measured; the focus
    // step is keyed on that measurement, not on `open`.
    await waitFor(() => expect(document.activeElement).toBe(apply));

    await userEvent.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on outside pointer but not on an inside click", async () => {
    const onOpenChange = vi.fn();
    render(<Host startOpen onOpenChange={onOpenChange} />);

    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Filters" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
  });

  it("does not respond to keyboard events after it closes", async () => {
    const onOpenChange = vi.fn();
    render(<Host startOpen onOpenChange={onOpenChange} />);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Apply" })),
    );

    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledTimes(1);

    // A second Escape reaches no layer: the document listener went with the
    // close, and focus was already returned to the trigger by the first one.
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger());
  });

  it("keeps Tab inside the dialog while it is open", async () => {
    render(
      <Host startOpen>
        <input aria-label="First field" />
        <button type="button">Last action</button>
      </Host>,
    );

    const first = screen.getByRole("textbox", { name: "First field" });
    const last = screen.getByRole("button", { name: "Last action" });
    await waitFor(() => expect(document.activeElement).toBe(first));

    await userEvent.tab();
    expect(document.activeElement).toBe(last);
    await userEvent.tab();
    expect(document.activeElement).toBe(first);
    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(last);
  });

  it("clamps and flips using the shared anchored-panel measurements", async () => {
    setViewport(390, 600);
    // 100px of trigger 60px above the bottom edge: below has 46px, above has
    // 486px, so the shared hook flips this panel upward.
    vi.spyOn(HTMLButtonElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 20,
      y: 500,
      top: 500,
      bottom: 540,
      left: 20,
      right: 120,
      width: 100,
      height: 40,
      toJSON: () => ({}),
    });

    render(<Host width={240} align="right" placement="below" />);
    await userEvent.click(trigger());

    const dialog = screen.getByRole("dialog", { name: "Filters" });
    expect(dialog.style.width).toBe("240px");
    // Aligning right would put the panel at -120px; the 8px viewport edge wins.
    expect(dialog.style.left).toBe("8px");
    expect(dialog.style.top).toBe("");
    expect(dialog.style.bottom).toBe("106px");
    expect(dialog.style.maxHeight).toBe("360px");
  });
});
