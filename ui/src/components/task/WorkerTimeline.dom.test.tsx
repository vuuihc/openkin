// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { t } from "../../i18n";
import WorkerTimeline from "./WorkerTimeline";
import type { WorkerRow } from "./workerActivity";

function row(patch: Partial<WorkerRow> = {}): WorkerRow {
  return {
    executionId: "turn-1",
    stepIndex: 0,
    agent: "claude",
    role: "research",
    access: "read",
    status: "running",
    attempt: 1,
    activity: [],
    total: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensKnown: false,
    unplanned: false,
    ...patch,
  };
}

/**
 * The stop control inside the worker timeline.
 *
 * Two things here are structural rather than cosmetic: the stop button must not
 * be nested inside the row's expand button (invalid HTML, and a tap would do
 * both things), and it must exist only while there is something to stop. A
 * button that offers to cancel a finished worker is a lie the API answers with
 * a 409.
 */
describe("WorkerTimeline", () => {
  it("stops a running worker without folding its row", () => {
    const onStop = vi.fn();
    render(<WorkerTimeline rows={[row()]} onStop={onStop} />);

    const stop = screen.getByRole("button", { name: t("task.workerStop") });
    // Sibling of the expand control, not a descendant of it.
    expect(stop.closest("button")).toBe(stop);

    const expand = screen.getByRole("button", { expanded: true });
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop.mock.calls[0][0]).toMatchObject({ executionId: "turn-1", stepIndex: 0 });
    // The stop click belongs to stop; the row stayed open as it was.
    expect(expand.getAttribute("aria-expanded")).toBe("true");
  });

  it("offers no stop for a settled row", () => {
    render(
      <WorkerTimeline
        rows={[row({ status: "succeeded" }), row({ stepIndex: 1, status: "canceled" })]}
        onStop={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: t("task.workerStop") })).toBeNull();
  });

  it("offers no stop when the caller has no way to cancel", () => {
    render(<WorkerTimeline rows={[row()]} />);
    expect(screen.queryByRole("button", { name: t("task.workerStop") })).toBeNull();
  });

  it("says a stop is in flight on that row only", () => {
    render(
      <WorkerTimeline
        rows={[row(), row({ stepIndex: 1 })]}
        onStop={() => {}}
        stoppingKey="turn-1-0"
      />,
    );
    const stopping = screen.getByRole("button", { name: t("task.workerStopping") });
    expect(stopping).toBeTruthy();
    // The other running row still reads "Stop", but cannot start a second
    // request while the first is in flight.
    const other = screen.getByRole("button", { name: t("task.workerStop") });
    expect((other as HTMLButtonElement).disabled).toBe(true);
    expect((stopping as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows each row's own token total when the adapter reported one", () => {
    render(
      <WorkerTimeline
        rows={[
          row({ stepIndex: 0, tokensIn: 1200, tokensOut: 300, tokensKnown: true }),
          row({ stepIndex: 1, tokensIn: 50, tokensOut: 0, tokensKnown: true }),
          row({ stepIndex: 2, tokensKnown: false }),
        ]}
      />,
    );
    expect(screen.getByText(t("task.workerTokens", { n: "1.5k" }))).toBeTruthy();
    expect(screen.getByText(t("task.workerTokens", { n: "50" }))).toBeTruthy();
    // The third row reported nothing; it must not claim "0 tokens".
    expect(screen.queryByText(t("task.workerTokens", { n: "0" }))).toBeNull();
  });
});
