// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AstryxProvider } from "../../design/AstryxProvider";
import { setLocale } from "../../i18n";
import Tooltip from "./Tooltip";
/**
 * F5e: the Tooltip facade `title=` will migrate onto — hover, focus,
 * leave/blur/Escape, a resolving `aria-describedby`, and a disabled state that
 * renders nothing.
 */
const CONTENT = "Sends the message";
function renderTooltip(props: Partial<Parameters<typeof Tooltip>[0]> = {}) {
  return render(
    <AstryxProvider>
      <Tooltip content={CONTENT} delay={10} {...props}>
        <button type="button">Send</button>
      </Tooltip>
    </AstryxProvider>,
  );
}
const trigger = () => screen.getByRole("button", { name: "Send" });
const tooltip = () => screen.queryByRole("tooltip");
/** jsdom has no pointer media query; the test states the one it needs. */
function coarsePointer() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: /pointer:\s*coarse/.test(query),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}
/**
 * jsdom has no Popover API: Astryx asks `:popover-open` whether its layer is on
 * screen, and jsdom answers false instead of throwing, so Escape would find no
 * layer to dismiss. A browser answers true while the manual popover is shown.
 */
function popoverOpenSelector() {
  const native = Element.prototype.matches;
  Element.prototype.matches = function (this: Element, selector: string) {
    if (selector === ":popover-open") return this.hasAttribute("popover");
    return native.call(this, selector);
  };
  return () => {
    Element.prototype.matches = native;
  };
}
let restoreMatches: () => void;
beforeEach(() => {
  setLocale("en");
  restoreMatches = popoverOpenSelector();
});
afterEach(() => {
  restoreMatches();
  vi.unstubAllGlobals();
});
describe("the shared tooltip", () => {
  it("shows after the delay on hover and hides on leave", async () => {
    const user = userEvent.setup();
    renderTooltip();
    expect(tooltip()).toBeNull();
    await user.hover(trigger());
    await waitFor(() => expect(tooltip()).not.toBeNull(), { timeout: 2000 });
    expect(tooltip()?.textContent).toContain(CONTENT);
    await user.unhover(trigger());
    await waitFor(() => expect(tooltip()).toBeNull(), { timeout: 2000 });
  });
  it("shows on keyboard focus and hides on blur", async () => {
    const user = userEvent.setup();
    renderTooltip();
    await user.tab();
    expect(document.activeElement).toBe(trigger());
    await waitFor(() => expect(tooltip()).not.toBeNull(), { timeout: 2000 });
    await user.tab();
    await waitFor(() => expect(tooltip()).toBeNull(), { timeout: 2000 });
  });
  it("Escape dismisses the tooltip and leaves focus on the trigger", async () => {
    const user = userEvent.setup();
    renderTooltip();
    await user.tab();
    await waitFor(() => expect(tooltip()).not.toBeNull(), { timeout: 2000 });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(tooltip()).toBeNull(), { timeout: 2000 });
    expect(document.activeElement).toBe(trigger());
  });
  it("the trigger is described by the tooltip content", async () => {
    const user = userEvent.setup();
    renderTooltip();
    await user.hover(trigger());
    await waitFor(() => expect(tooltip()).not.toBeNull(), { timeout: 2000 });
    const describedBy = trigger().getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toContain(CONTENT);
  });
  it("does not render or announce anything when disabled", async () => {
    const user = userEvent.setup();
    renderTooltip({ disabled: true });
    await user.hover(trigger());
    await user.tab();
    expect(tooltip()).toBeNull();
    expect(screen.queryByText(CONTENT)).toBeNull();
    expect(trigger().hasAttribute("aria-describedby")).toBe(false);
  });
  it("a tap opens it on a coarse pointer", async () => {
    coarsePointer();
    renderTooltip({ delay: 10 });
    const el = trigger();
    fireEvent.pointerDown(el, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      bubbles: true,
    });
    fireEvent.pointerUp(el, {
      pointerType: "touch",
      pointerId: 1,
      isPrimary: true,
      bubbles: true,
    });
    // Astryx's `touchTrigger` opens on the tap's `click`, the verdict its
    // recognizer delivers when the finger lifts, not on the press itself.
    fireEvent.click(el);
    await waitFor(() => expect(tooltip()).not.toBeNull(), { timeout: 2000 });
    expect(tooltip()?.textContent).toContain(CONTENT);
  });
});
