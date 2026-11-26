// @vitest-environment jsdom
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Menu, { type MenuItem } from "./Menu";
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

/**
 * Two layers, the inner one opened from the parent's panel and portaled to
 * `<body>`. Both `onOpenChange` callbacks are inline, so every render hands
 * each layer a fresh closure and React re-subscribes its document listeners
 * in an order the component does not control — the case where "one Escape
 * dismisses one layer" must not depend on listener order.
 */
function NestedHost() {
  const [outer, setOuter] = useState(false);
  const [inner, setInner] = useState(false);
  const outerRef = useRef<HTMLButtonElement>(null);
  const innerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={outerRef} type="button" onClick={() => setOuter((value) => !value)}>
        Outer trigger
      </button>
      <button type="button">Outside</button>
      <Popover
        open={outer}
        onOpenChange={(value) => setOuter(value)}
        triggerRef={outerRef}
        label="Outer"
      >
        <button ref={innerRef} type="button" onClick={() => setInner(true)}>
          Inner trigger
        </button>
        <Popover
          open={inner}
          onOpenChange={(value) => setInner(value)}
          triggerRef={innerRef}
          label="Inner"
        >
          <button type="button">Inner action</button>
        </Popover>
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

/**
 * A real `Menu` on a trigger near the bottom edge, which is the surface that
 * reported the clip: the conversation row's `⋯` menu at 1100×760. jsdom has no
 * layout, so the trigger's rect and the panel's content height are stubs; the
 * placement decision they feed is the code under test.
 */
function RowMenuHost({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(true);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={triggerRef} type="button" aria-expanded={open} onClick={() => setOpen(true)}>
        Row actions
      </button>
      <Menu
        open={open}
        onOpenChange={setOpen}
        triggerRef={triggerRef}
        label="Row actions"
        items={items}
      />
    </div>
  );
}

describe("a menu whose trigger sits near the bottom edge (R-menu-clip-1100)", () => {
  it("opens on the side that can show a menu's rows", async () => {
    setViewport(1100, 760);
    // 1100×760 with the trigger 160px above the bottom: below leaves
    // 760 − 600 − 8 (edge) − 6 (gap) = 146px, above leaves 560 − 14 = 546px.
    // The old FLIP_BELOW=120 rule kept this menu below and clamped it to
    // 146px, cutting the last rows off a panel whose scrollbar is invisible.
    vi.spyOn(HTMLButtonElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 800,
      y: 560,
      top: 560,
      bottom: 600,
      left: 800,
      right: 876,
      width: 76,
      height: 40,
      toJSON: () => ({}),
    });
    // The panel's content is taller than the room below and shorter than the
    // 360px a menu allows: a running row with its reason line plus enough
    // actions to push the last one past the clip.
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(320);
    const items: MenuItem[] = [
      {
        id: "running",
        label: "Running",
        description: "The agent is still working",
        disabled: true,
        onSelect: vi.fn(),
      },
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `action-${index}`,
        label: `Action ${index + 1}`,
        onSelect: vi.fn(),
      })),
    ];

    render(<RowMenuHost items={items} />);

    const dialog = await screen.findByRole("dialog", { name: "Row actions" });
    // Above: bottom is set and top is not, so the panel grows upward from the
    // trigger instead of being pinned below with 146px of room.
    expect(dialog.style.bottom).toBe("206px");
    expect(dialog.style.top).toBe("");
    expect(dialog.style.maxHeight).toBe("360px");

    // The disabled row, its label and its reason are inside the scrollport,
    // and the panel is tall enough for the content that was measured.
    const row = screen.getByRole("menuitem", { name: /Running/ });
    expect(dialog.contains(row)).toBe(true);
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(row.textContent).toContain("Running");
    expect(row.textContent).toContain("The agent is still working");
    expect(Number.parseFloat(dialog.style.maxHeight)).toBeGreaterThanOrEqual(320);
  });

  it("keeps the preferred side when that side can show the measured content", async () => {
    setViewport(1100, 760);
    // The same trigger and the same 146px below / 546px above. The content is
    // only 120px, so the preferred side can show all of it and must be kept:
    // flipping a well-fitting menu moves it for no reason. This is the
    // keep-preferred branch of the decision, and the case where both sides fit.
    vi.spyOn(HTMLButtonElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 800,
      y: 560,
      top: 560,
      bottom: 600,
      left: 800,
      right: 876,
      width: 76,
      height: 40,
      toJSON: () => ({}),
    });
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(120);
    const items: MenuItem[] = Array.from({ length: 3 }, (_, index) => ({
      id: `action-${index}`,
      label: `Action ${index + 1}`,
      onSelect: vi.fn(),
    }));

    render(<RowMenuHost items={items} />);

    const dialog = await screen.findByRole("dialog", { name: "Row actions" });
    // 760 − 600 − 8 (edge) − 6 (gap) = 146px below, which fits the 120px of
    // content, so the panel stays under the trigger instead of flipping up.
    expect(dialog.style.top).toBe("606px");
    expect(dialog.style.bottom).toBe("");
    expect(dialog.style.maxHeight).toBe("146px");
  });
});

describe("focus containment with controls nobody can see", () => {
  it("skips hidden first and last controls for initial focus and Tab wrapping", async () => {
    render(
      <Host startOpen>
        <button type="button" hidden>
          Hidden first
        </button>
        <button type="button">Visible first</button>
        <button type="button">Visible last</button>
        <button type="button" style={{ display: "none" }}>
          Hidden last
        </button>
      </Host>,
    );

    const hiddenFirst = screen.getByText("Hidden first");
    const hiddenLast = screen.getByText("Hidden last");
    const visibleFirst = screen.getByRole("button", { name: "Visible first" });
    const visibleLast = screen.getByRole("button", { name: "Visible last" });

    // Initial focus must land on the first control that can actually take it.
    await waitFor(() => expect(document.activeElement).toBe(visibleFirst));

    // With the hidden last control counted, Tab from the visible last would
    // wrap onto nothing and focus would fall to <body> with the dialog open.
    await userEvent.tab();
    expect(document.activeElement).toBe(visibleLast);
    expect(document.activeElement).not.toBe(hiddenLast);
    expect(document.activeElement).not.toBe(document.body);

    await userEvent.tab();
    expect(document.activeElement).toBe(visibleFirst);
    expect(document.activeElement).not.toBe(document.body);

    await userEvent.tab({ shift: true });
    expect(document.activeElement).toBe(visibleLast);
    expect(document.activeElement).not.toBe(hiddenFirst);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("leaves focus alone when the content placed it itself", async () => {
    render(
      <Host startOpen>
        <button type="button">First</button>
        {/* A list that opens on its current choice, or a field with
            `autoFocus`, has already put focus where the reader needs it
            during the commit. The panel's fallback must not overrule it. */}
        <button type="button" autoFocus>
          Chosen
        </button>
      </Host>,
    );

    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Chosen" })),
    );
    expect(document.activeElement).not.toBe(screen.getByRole("button", { name: "First" }));
  });
});

describe("nested layers", () => {
  async function openBoth() {
    render(<NestedHost />);
    await userEvent.click(screen.getByRole("button", { name: "Outer trigger" }));
    await userEvent.click(screen.getByRole("button", { name: "Inner trigger" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Inner action" })),
    );
  }

  const dialogNames = () =>
    screen.queryAllByRole("dialog").map((element) => element.getAttribute("aria-label"));

  it("dismisses exactly one layer per Escape", async () => {
    await openBoth();
    expect(dialogNames()).toEqual(["Outer", "Inner"]);

    await userEvent.keyboard("{Escape}");

    // One press closes the inner layer and nothing else, whichever document
    // listener ran first.
    expect(dialogNames()).toEqual(["Outer"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Inner trigger" }));

    await userEvent.keyboard("{Escape}");

    expect(dialogNames()).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Outer trigger" }));
  });

  it("dismisses the deepest open layer even when focus stays in the parent", async () => {
    await openBoth();

    // The caret moved back to the parent's own content. The nested layer is
    // still the one opened last, so the first Escape belongs to it: closing
    // the parent here would leave the nested panel floating over a layer that
    // no longer exists.
    screen.getByRole("button", { name: "Inner trigger" }).focus();
    await userEvent.keyboard("{Escape}");

    expect(dialogNames()).toEqual(["Outer"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Inner trigger" }));

    await userEvent.keyboard("{Escape}");
    expect(dialogNames()).toEqual([]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Outer trigger" }));
  });

  it("does not dismiss the parent when the nested panel is clicked", async () => {
    await openBoth();

    await userEvent.click(screen.getByRole("button", { name: "Inner action" }));

    // The inner panel is portaled to <body>, so DOM containment alone calls
    // it "outside" and closes the parent behind it.
    expect(dialogNames()).toEqual(["Outer", "Inner"]);

    await userEvent.click(screen.getByRole("button", { name: "Outside" }));

    expect(dialogNames()).toEqual([]);
  });
});

describe("input guards", () => {
  it("leaves Escape to an IME composition, on both signals", async () => {
    const onOpenChange = vi.fn();
    render(
      <Host startOpen onOpenChange={onOpenChange}>
        <input aria-label="Compose" />
      </Host>,
    );
    const input = screen.getByRole("textbox", { name: "Compose" });
    await waitFor(() => expect(document.activeElement).toBe(input));

    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Filters" })).toBeTruthy();
    expect(document.activeElement).toBe(input);

    // Older IMEs report the composition through the 229 sentinel instead.
    fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Filters" })).toBeTruthy();
    expect(document.activeElement).toBe(input);

    // A plain Escape still dismisses.
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
  });

  it("dismisses on a touch pointerdown outside but not inside", async () => {
    const onOpenChange = vi.fn();
    render(<Host startOpen onOpenChange={onOpenChange} />);
    const apply = screen.getByRole("button", { name: "Apply" });
    await waitFor(() => expect(document.activeElement).toBe(apply));

    fireEvent.pointerDown(apply, { pointerType: "touch" });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Filters" })).toBeTruthy();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }), {
      pointerType: "touch",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("dialog", { name: "Filters" })).toBeNull();
  });
});
