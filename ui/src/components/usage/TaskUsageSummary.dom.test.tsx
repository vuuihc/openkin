// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
