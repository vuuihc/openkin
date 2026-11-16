// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale, t } from "../../i18n";
import Composer from "./Composer";

/**
 * The composer card is one card with one control row.
 *
 * The input, the run settings, the attach control and send/stop all live on a
 * single row inside the card, and that row never wraps: the run-config slot is
 * the one thing allowed to scroll sideways when it does not fit, so the row
 * keeps one height and the send control keeps its place at the end.
 *
 * Every control on the row is the shared `Button` facade, so focus rings,
 * disabled state and the 44px touch floor come from one place rather than each
 * call site assembling a shape — and send is the accent control only when there
 * is something to send.
 */

function setup(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onSubmit = vi.fn();
  const utils = render(<Composer onSubmit={onSubmit} {...props} />);
  const row = utils.container.querySelector<HTMLElement>("[data-kin-composer-row]");
  if (!row) throw new Error("the composer has no [data-kin-composer-row] control row");
  return { onSubmit, row, ...utils };
}

beforeEach(() => {
  setLocale("en");
});

describe("Composer control row", () => {
  it("places the run-config slot inside the control row", () => {
    const { row } = setup({ footerWide: true, footer: <span data-testid="cfg" /> });

    const slot = screen.getByTestId("cfg");
    expect(row.contains(slot)).toBe(true);
    expect(within(row).getByRole("button", { name: t("composer.attachFile") })).toBeTruthy();
    expect(within(row).getByRole("button", { name: t("composer.send") })).toBeTruthy();
  });

  it("keeps one non-wrapping control row", () => {
    const { row } = setup({ footerWide: true, footer: <span data-testid="cfg" /> });

    expect(row.classList.contains("flex-nowrap")).toBe(true);
    expect(row.classList.contains("flex-wrap")).toBe(false);
    // The slot's wrapper is what scrolls when the run config is wider than the
    // row; the row itself must never wrap or scroll as a whole.
    const slotWrapper = screen.getByTestId("cfg").parentElement;
    expect(slotWrapper).not.toBeNull();
    expect(slotWrapper!.classList.contains("overflow-x-auto")).toBe(true);
    expect(row.classList.contains("overflow-x-auto")).toBe(false);
  });

  it("reserves the key hints so only the run-config slot can shrink", async () => {
    const user = userEvent.setup();
    const { row } = setup({ footerWide: true, footer: <span data-testid="cfg" /> });

    // The hints only expand once there is a draft; that is the state where the
    // row is widest and the card can overflow.
    await user.type(screen.getByRole("textbox"), "h");

    const hints = Array.from(row.querySelectorAll("kbd")).map((kbd) => kbd.parentElement);
    expect(hints).toHaveLength(2);
    for (const hint of hints) {
      expect(hint).not.toBeNull();
      // Non-shrinking: their width is reserved, so the flexible slot is what
      // gives way and scrolls. A shrinkable hint collapses instead and lets
      // the row paint past the card's edge.
      expect(hint!.classList.contains("flex-none")).toBe(true);
      expect(row.contains(hint)).toBe(true);
    }

    const slotWrapper = screen.getByTestId("cfg").parentElement!;
    expect(slotWrapper.classList.contains("flex-1")).toBe(true);
    expect(slotWrapper.classList.contains("min-w-0")).toBe(true);
    expect(slotWrapper.classList.contains("overflow-x-auto")).toBe(true);
  });

  it("sends from a quiet button until there is something to send", async () => {
    const user = userEvent.setup();
    setup();

    const send = screen.getByRole("button", { name: t("composer.send") });
    expect(send.classList.contains("kin-btn")).toBe(true);
    expect(send.classList.contains("kin-btn-primary")).toBe(false);

    await user.type(screen.getByRole("textbox"), "h");
    expect(send.classList.contains("kin-btn-primary")).toBe(true);
  });

  it("stop and send are facade buttons", async () => {
    const user = userEvent.setup();
    setup({ running: true, onStop: vi.fn() });

    const stop = screen.getByRole("button", { name: t("composer.stop") });
    expect(stop.classList.contains("kin-btn")).toBe(true);
    expect(stop.classList.contains("kin-btn-secondary")).toBe(true);

    // A running round puts stop in the primary slot; there is no send until
    // the draft gives the person something to do with it.
    expect(screen.queryByRole("button", { name: t("composer.send") })).toBeNull();

    await user.type(screen.getByRole("textbox"), "next");
    // A sendable draft shows the two explicit peers: cut the round short, or
    // queue behind it. Both are facade buttons, and the queue — the control
    // that actually sends — carries the accent.
    const queue = screen.getByRole("button", { name: t("composer.send") });
    expect(queue.classList.contains("kin-btn")).toBe(true);
    expect(queue.classList.contains("kin-btn-primary")).toBe(true);

    const interrupt = screen.getByRole("button", { name: t("composer.interruptSend") });
    expect(interrupt.classList.contains("kin-btn")).toBe(true);
    expect(interrupt.classList.contains("kin-btn-secondary")).toBe(true);
  });

  it("the attach control is a facade quiet button", () => {
    const click = vi.spyOn(HTMLInputElement.prototype, "click");
    const { container } = setup();
    const attach = screen.getByRole("button", { name: t("composer.attachFile") });

    // The facade's base class is the contract; `quiet` adds no `kin-btn-*`
    // weight of its own, so the transparent fill is the quiet marker and the
    // test does not pin a hand-built shape.
    expect(attach.classList.contains("kin-btn")).toBe(true);
    expect(attach.classList.contains("bg-transparent")).toBe(true);

    fireEvent.click(attach);

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.instances[0]).toBe(input);
    click.mockRestore();
  });
});
