// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskUsage } from "../../api/client";
import { t } from "../../i18n";
import TaskUsageSummary from "./TaskUsageSummary";

/**
 * The context meter, which is the one line in the usage sheet that answers a
 * question about the *next* turn rather than about the bill.
 *
 * What is pinned here is the honesty of the denominator: a window drawn only
 * when it is known, a bar that clamps while the number beside it does not, and
 * a hint that appears at the thresholds rather than on every render.
 *
 * Strings come from `t` rather than from the English locale so the test says
 * the same thing in whichever language the harness boots into.
 */
function usage(overrides: Partial<TaskUsage> = {}): TaskUsage {
  return {
    task_id: "task-1",
    tokens_in: 1234,
    tokens_out: 200,
    cost_usd: 0.02,
    request_count: 3,
    reasoning_output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cache_eligible_input_tokens: 0,
    cache_hit_rate: null,
    cache_coverage: null,
    cache_status: "unknown",
    model_subtotals: [],
    cost_source_subtotals: [],
    ...overrides,
  };
}

function openDetails() {
  // The details are folded by default; every assertion below is about what is
  // inside them.
  fireEvent.click(
    screen.getByRole("button", {
      name: (name) => name.includes(t("usage.taskSummary")),
    }),
  );
}

const meter = () => screen.queryByRole("progressbar", { name: t("usage.context") });

describe("TaskUsageSummary context meter", () => {
  it("shows usage against the window when both are known", () => {
    const { container } = render(
      <TaskUsageSummary
        usage={usage({ context: { tokens: 1234, model: "gpt-5-codex" }, context_window: 200_000 })}
        loading={false}
        variant="strip"
      />,
    );
    openDetails();
    const bar = meter();
    expect(bar).toBeTruthy();
    expect(bar?.getAttribute("aria-valuenow")).toBe("1");
    expect(bar?.getAttribute("aria-valuetext")).toBe("1.2k / 200.0k");
    expect(container.textContent).toContain("1%");
  });

  it("draws no meter when the window is unknown", () => {
    const { container } = render(
      <TaskUsageSummary
        usage={usage({ context: { tokens: 1234, model: "unlisted" }, context_window: 0 })}
        loading={false}
        variant="strip"
      />,
    );
    openDetails();
    // Tokens are still reported in the grid; only the denominator is missing.
    expect(meter()).toBeNull();
    expect(container.textContent).not.toContain(t("usage.contextNearFull"));
  });

  it("draws no meter before any request has reported input", () => {
    render(
      <TaskUsageSummary
        usage={usage({ context: { tokens: 0, model: "gpt-5-codex" }, context_window: 200_000 })}
        loading={false}
        variant="strip"
      />,
    );
    openDetails();
    expect(meter()).toBeNull();
  });

  it("clamps the bar at full while the percentage stays honest", () => {
    const { container } = render(
      <TaskUsageSummary
        usage={usage({
          context: { tokens: 210_000, model: "gpt-5-codex" },
          context_window: 200_000,
        })}
        loading={false}
        variant="strip"
      />,
    );
    openDetails();
    const bar = meter();
    // A request past the ceiling is a thing that happens; the bar cannot show
    // it, but the reader must not be told 100% when it is 105%.
    expect(bar?.getAttribute("aria-valuenow")).toBe("100");
    expect(container.textContent).toContain("105%");
    expect(container.textContent).toContain(t("usage.contextFull"));
  });

  it("warns before the window is full", () => {
    const { container } = render(
      <TaskUsageSummary
        usage={usage({
          context: { tokens: 170_000, model: "gpt-5-codex" },
          context_window: 200_000,
        })}
        loading={false}
        variant="strip"
      />,
    );
    openDetails();
    expect(container.textContent).toContain(t("usage.contextNearFull"));
    expect(container.textContent).not.toContain(t("usage.contextFull"));
  });

  it("draws the meter in the side-rail card too", () => {
    // The card and the strip share one details block, but they reach it through
    // different trees: the card folds it behind its own toggle. Dropping the
    // meter from that tree would leave every strip test green.
    render(
      <TaskUsageSummary
        usage={usage({ context: { tokens: 1234, model: "gpt-5-codex" }, context_window: 200_000 })}
        loading={false}
        variant="card"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t("usage.showDetails") }));
    expect(meter()).toBeTruthy();
  });

  it("draws the meter in the phone sheet too", () => {
    render(
      <TaskUsageSummary
        usage={usage({ context: { tokens: 1234, model: "gpt-5-codex" }, context_window: 200_000 })}
        loading={false}
        variant="phone"
      />,
    );
    // The phone face is a button that opens a sheet; the meter lives inside it.
    const opener = screen
      .getAllByRole("button")
      .find((button) => button.getAttribute("aria-haspopup") === "dialog");
    expect(opener).toBeTruthy();
    fireEvent.click(opener!);
    expect(meter()).toBeTruthy();
  });

  it("says nothing extra with plenty of room left", () => {
    const { container } = render(
      <TaskUsageSummary
        usage={usage({
          context: { tokens: 20_000, model: "gpt-5-codex" },
          context_window: 200_000,
        })}
        loading={false}
        variant="strip"
      />,
    );
    openDetails();
    expect(meter()).toBeTruthy();
    expect(container.textContent).not.toContain(t("usage.contextNearFull"));
    expect(container.textContent).not.toContain(t("usage.contextFull"));
  });
});

describe("TaskUsageSummary vocabulary", () => {
  it("titles the conversation's usage bar 对话用量摘要", () => {
    // The default locale is zh, so this is the literal a Chinese reader sees.
    // Every other assertion in this file asks `t()` for the title, which stays
    // green whichever word the catalogue uses; this one pins the word itself.
    render(<TaskUsageSummary usage={usage()} loading={false} variant="strip" />);
    expect(screen.getByText("对话用量摘要")).toBeTruthy();
  });
});

/** A control the shared facade owns: a real <button> carrying the facade surface. */
function expectFacade(el: HTMLElement) {
  expect(el.tagName).toBe("BUTTON");
  expect(el.className).toContain("kin-btn");
  expect(el.className).toContain("focus-visible:outline-kin-focus-ring");
}

describe("TaskUsageSummary phone trigger says what the number counts", () => {
  // On a 390px phone the trigger rendered a bare "49": its accessible name
  // said "conversation usage summary", but a sighted reader only saw the
  // number. The unit is the smallest fix that keeps the 44pt face, the
  // composer row and the accessible name unchanged (TASTE 18: the visible
  // words agree with the name instead of inventing a second one).
  function phoneOpener() {
    render(
      <TaskUsageSummary
        usage={usage({ tokens_in: 49, tokens_out: 0 })}
        loading={false}
        variant="phone"
      />,
    );
    return screen
      .getAllByRole("button")
      .find((button) => button.getAttribute("aria-haspopup") === "dialog")!;
  }

  it("phone trigger names its unit at a small total", () => {
    const opener = phoneOpener();
    expect(opener.textContent).not.toBe("49");
    expect(opener.textContent).toContain("49");
    // The unit comes from the locale catalogue, so the zh reader sees
    // "49 Token" and the en reader "49 Tokens" from the same code path.
    expect(opener.textContent).toContain(t("usage.tokens"));
  });

  it("phone trigger still carries the full accessible name", () => {
    // Only the visible layer changed: the name still spells the field and the
    // total in the same shape the strip's disclosure uses.
    const opener = phoneOpener();
    expect(opener.getAttribute("aria-label")).toBe(
      `${t("usage.taskSummary")}${t("common.labelSeparator")}49`,
    );
  });
});

describe("TaskUsageSummary controls on the facade (E4c)", () => {
  it("both disclosure toggles and the phone trigger are facade buttons", async () => {
    const user = userEvent.setup();

    // The desktop strip: the whole row is the disclosure.
    const strip = render(<TaskUsageSummary usage={usage()} loading={false} variant="strip" />);
    const stripToggle = screen.getByRole("button", {
      name: (name) => name.includes(t("usage.showDetails")),
    });
    expectFacade(stripToggle);
    expect(stripToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(stripToggle);
    expect(stripToggle.getAttribute("aria-expanded")).toBe("true");
    const detailsID = stripToggle.getAttribute("aria-controls");
    expect(detailsID).toBeTruthy();
    expect(document.getElementById(detailsID!)).toBeTruthy();
    strip.unmount();

    // The side-rail card's small toggle.
    const card = render(<TaskUsageSummary usage={usage()} loading={false} variant="card" />);
    const cardToggle = screen.getByRole("button", { name: t("usage.showDetails") });
    expectFacade(cardToggle);
    expect(cardToggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(cardToggle);
    expect(cardToggle.getAttribute("aria-expanded")).toBe("true");
    card.unmount();

    // The phone trigger rides the composer row: same 44px face, same name,
    // and it still opens the sheet.
    const phone = render(<TaskUsageSummary usage={usage()} loading={false} variant="phone" />);
    const opener = screen.getByRole("button", {
      name: (name) => name.includes(t("usage.taskSummary")),
    });
    expectFacade(opener);
    expect(opener.className).toContain("h-11");
    expect(opener.className).toContain("min-w-11");
    expect(opener.getAttribute("aria-haspopup")).toBe("dialog");
    expect(opener.getAttribute("aria-label")).toBe(
      `${t("usage.taskSummary")}${t("common.labelSeparator")}1.4k`,
    );
    await user.click(opener);
    expect(await screen.findByRole("dialog", { name: t("usage.taskSummary") })).toBeTruthy();
    phone.unmount();
  });

  it("the strip keeps its title, totals and toggle on one flex row", () => {
    // The facade wraps every child in a single label span, so loose spans
    // would render inline there and lose the gap, the truncation and the
    // right edge. One child of our own has to own the row.
    render(<TaskUsageSummary usage={usage()} loading={false} variant="strip" />);
    const title = screen.getByText(t("usage.taskSummary"));
    const row = title.parentElement as HTMLElement;
    expect(row.className).toContain("flex");
    expect(row.className).toContain("w-full");
    expect(row.className).toContain("gap-2");
    expect(row.className).toContain("min-w-0");
    // The facade's label span is content-sized; without these the row is only
    // as wide as its text and the toggle never reaches the right edge.
    expect(title.closest("button")?.className).toContain("[&>span>span]:w-full");
    expect(row.children).toHaveLength(3);
    // …and it is the only child of the facade's label span, so the three
    // controls are flex items of `row` rather than inline runs inside it.
    expect(row.parentElement?.children).toHaveLength(1);
    expect(title.nextElementSibling?.className).toContain("truncate");
    expect(row.lastElementChild?.textContent).toBe(t("usage.showDetails"));
  });
});

/**
 * R-usage-sheet-820: the composer footer renders this phone variant at every
 * width below the 1600px side rail — 768–1599 included. The sheet it opens
 * used to be the bare bottom sheet, which is `md:hidden` and closes itself the
 * moment the breakpoint matches, so at 820 and 1100 the chip opened and shut
 * inside one commit. jsdom has no `matchMedia` and the shared setup adds none;
 * without the stub below the breakpoint effect bails out and every assertion
 * here would pass against the broken control.
 */
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  window.matchMedia = ((query: string) => ({
    // A getter, not a copy: the component re-reads `matches` when the change
    // fires, which is how a real MediaQueryList behaves.
    get matches() {
      return matches;
    },
    media: query,
    onchange: null,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    addListener: (fn: () => void) => listeners.add(fn),
    removeListener: (fn: () => void) => listeners.delete(fn),
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      matches = next;
      for (const fn of listeners) fn();
    },
  };
}

describe("R-usage-sheet-820 the tablet usage sheet", () => {
  const originalMatchMedia = window.matchMedia;
  let back: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // A sheet gives its history entry back on close. jsdom queues a real
    // traversal, and its popstate can land in the next test; the mock keeps
    // each test's history deterministic, exactly as Sheet.dom.test.tsx does.
    back = vi.spyOn(window.history, "back").mockImplementation(() => {});
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    back.mockRestore();
  });

  function renderPhone() {
    render(<TaskUsageSummary usage={usage()} loading={false} variant="phone" />);
    return screen.getByRole("button", {
      name: (name) => name.includes(t("usage.taskSummary")),
    });
  }

  it("R-usage-sheet-820: the tablet trigger's sheet stays open past 768", async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    const opener = renderPhone();
    await user.click(opener);
    expect(await screen.findByRole("dialog", { name: t("usage.taskSummary") })).toBeTruthy();
    expect(opener.getAttribute("aria-expanded")).toBe("true");
  });

  it("R-usage-sheet-820: below 768 it is still the bottom sheet", async () => {
    // `dialog` deliberately drops the layer's `md:hidden` (Sheet.tsx:521):
    // that class and the breakpoint auto-close are what made the chip dead at
    // 820, and a sheet that stays visible above `md` opts out of both. The
    // phone shape therefore lives in the base classes, with every centring or
    // radius change scoped to `md:` — the 390×844 screenshot proves the
    // rendered result; this pins the contract that keeps it a bottom sheet.
    stubMatchMedia(false);
    const user = userEvent.setup();
    await user.click(renderPhone());
    const panel = await screen.findByRole("dialog", { name: t("usage.taskSummary") });
    const layer = document.querySelector("[data-kin-sheet]")!;
    expect(layer.className).toContain("justify-end");
    expect(layer.className).toContain("md:justify-center");
    expect(panel.className).toContain("rounded-t-2xl");
    expect(panel.className).toContain("md:rounded-2xl");
    // The touch tablet at 820 can still pull the centred panel down.
    expect(document.querySelector("[data-sheet-grip]")).toBeTruthy();
  });

  it("R-usage-sheet-820: at 820 the layer is not the hidden phone sheet", async () => {
    stubMatchMedia(true);
    const user = userEvent.setup();
    await user.click(renderPhone());
    const panel = await screen.findByRole("dialog", { name: t("usage.taskSummary") });
    expect(document.querySelector("[data-kin-sheet]")!.className).not.toContain("md:hidden");
    expect(panel.className).toContain("md:rounded-2xl");
  });
});
