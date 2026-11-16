// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { setLocale } from "../../i18n";
import SessionFilters, {
  normalizeScopeFilter,
  normalizeStatusFilter,
  type SessionScopeFilter,
  type SessionStatusFilter,
} from "./SessionFilters";
import type { SessionAttentionFilter } from "../../lib/sessionAttention";

/**
 * The list's attention chips and exact-status panel.
 *
 * The chip row answers "what needs me / what is moving" with one tap and a
 * live count; the panel behind the trigger keeps the six exact statuses and
 * the project sort. Two rules are worth a DOM test because they are invisible
 * in the pure helpers: the trigger must say which exact status is applied (a
 * filter the list obeys but the control does not show reads as "rows are
 * missing"), and one click must hand back the whole next view in one call —
 * the page writes the URL per change, so two calls would leave a history entry
 * and a frame of half-state.
 */

const chipGroup = () => screen.getByRole("group", { name: "Conversation view" });
const chip = (name: string) => within(chipGroup()).getByRole("button", { name });
const chipButtons = () => within(chipGroup()).getAllByRole("button") as HTMLButtonElement[];
const pressedChips = () =>
  chipButtons().filter((button) => button.getAttribute("aria-pressed") === "true");
// The chip row and the panel options also carry aria-pressed, so the trigger
// is the one control with an expanded state — at either value.
const trigger = () =>
  screen
    .getAllByRole("button")
    .find((button) => button.hasAttribute("aria-expanded")) as HTMLButtonElement;

type Props = {
  status: SessionStatusFilter;
  scope: SessionScopeFilter;
  attention: SessionAttentionFilter;
  needsYouCount: number;
  runningCount: number;
  onChange: (next: {
    status: SessionStatusFilter;
    scope: SessionScopeFilter;
    attention: SessionAttentionFilter;
  }) => void;
};

function view(overrides: Partial<Props> = {}) {
  return (
    <SessionFilters
      status={overrides.status ?? ""}
      scope={overrides.scope ?? "active"}
      attention={overrides.attention ?? ""}
      needsYouCount={overrides.needsYouCount ?? 0}
      runningCount={overrides.runningCount ?? 0}
      onChange={overrides.onChange ?? vi.fn()}
    />
  );
}

function setup(overrides: Partial<Props> = {}) {
  const onChange = overrides.onChange ?? vi.fn();
  const { rerender } = render(view({ ...overrides, onChange }));
  return {
    onChange,
    rerender: (next: Partial<Props> = {}) => rerender(view({ ...overrides, ...next, onChange })),
  };
}

beforeEach(() => {
  setLocale("en");
});

describe("SessionFilters", () => {
  it("shows All, Needs you, Running and Archived as one chip row with All pressed by default", () => {
    setup();
    expect(chipGroup()).toBeTruthy();
    for (const label of ["All", "Needs you", "Running", "Archived"]) {
      expect(chip(label)).toBeTruthy();
    }
    expect(pressedChips()).toHaveLength(1);
    expect(chip("All").getAttribute("aria-pressed")).toBe("true");
    // One view at a time: the other three say so rather than relying on colour.
    for (const label of ["Needs you", "Running", "Archived"]) {
      expect(chip(label).getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("shows a live count on Needs you and Running and hides it at zero", () => {
    const { rerender } = setup({ needsYouCount: 3, runningCount: 2 });
    expect(chip("Needs you").textContent).toContain("3");
    expect(chip("Running").textContent).toContain("2");

    // Zero is not a count: the chip keeps its label and loses the bubble, so a
    // quiet list does not read as four badges.
    rerender({ needsYouCount: 0, runningCount: 0 });
    expect(chip("Needs you").textContent).toBe("Needs you");
    expect(chip("Running").textContent).toBe("Running");
  });

  it("describes each count in words for a screen reader, not as a bare number", () => {
    // The number is aria-hidden; without its sentence a screen reader would
    // announce "Needs you 3" and never say what the 3 counts.
    setup({ needsYouCount: 3, runningCount: 2 });

    const needs = chip("Needs you");
    const needsNumber = within(needs).getByText("3");
    expect(needsNumber.getAttribute("aria-hidden")).toBe("true");
    const needsSentence = document.getElementById(needs.getAttribute("aria-describedby")!);
    expect(needsSentence?.textContent).toBe("3 conversations need you");

    const running = chip("Running");
    const runningNumber = within(running).getByText("2");
    expect(runningNumber.getAttribute("aria-hidden")).toBe("true");
    const runningSentence = document.getElementById(running.getAttribute("aria-describedby")!);
    expect(runningSentence?.textContent).toBe("2 conversations running");
  });

  it("selecting Needs you reports attention needs and the cleared exact status in one change", () => {
    const { onChange } = setup({ status: "failed" });
    fireEvent.click(chip("Needs you"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      status: "",
      scope: "active",
      attention: "needs",
    });
  });

  it("selecting Archived reports the archived scope and leaves exactly one chip pressed", () => {
    const { onChange, rerender } = setup({ attention: "running" });
    fireEvent.click(chip("Archived"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      status: "",
      scope: "archived",
      attention: "",
    });

    rerender({ scope: "archived", attention: "" });
    const pressed = pressedChips();
    expect(pressed).toHaveLength(1);
    expect(pressed[0].textContent).toContain("Archived");
  });

  it("starts with the panel closed, so its status options are not in the tab order", () => {
    setup();
    expect(trigger().textContent).toContain("Filter");
    expect(screen.queryByRole("group", { name: "Status" })).toBeNull();
  });

  it("names the applied exact status on the closed trigger", () => {
    // Scope is a chip now, so it is not part of the trigger's summary: the
    // trigger speaks only for the panel it opens.
    setup({ status: "running", scope: "archived" });
    expect(trigger().textContent).toContain("Running");
    expect(trigger().textContent).not.toContain("Archived");
    expect(chip("Archived").getAttribute("aria-pressed")).toBe("true");
  });

  it("reports a status choice with the scope and attention unchanged", () => {
    const { onChange } = setup({ scope: "active", attention: "needs" });
    fireEvent.click(trigger());
    fireEvent.click(
      within(screen.getByRole("group", { name: "Status" })).getByRole("button", {
        name: "Failed",
      }),
    );
    expect(onChange).toHaveBeenCalledWith({
      status: "failed",
      scope: "active",
      attention: "needs",
    });
  });

  it("toggles a chosen status off rather than leaving it stuck", () => {
    const { onChange } = setup({ status: "running" });
    fireEvent.click(trigger());
    // The chip row also has a "Running" button, so scope the click to the
    // panel's group.
    fireEvent.click(
      within(screen.getByRole("group", { name: "Status" })).getByRole("button", {
        name: "Running",
      }),
    );
    expect(onChange).toHaveBeenCalledWith({
      status: "",
      scope: "active",
      attention: "",
    });
  });

  it("clears the exact status and leaves the chip row alone", () => {
    const { onChange } = setup({ status: "failed", attention: "needs" });
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      status: "",
      scope: "active",
      attention: "needs",
    });
  });

  it("offers every exact status in the panel, including canceled", () => {
    // Canceled is the one status the row dot draws nothing for, so the chip is
    // the only way to find a canceled run in a list that shows a hundred rows.
    setup({ status: "failed" });
    fireEvent.click(trigger());
    const statusGroup = screen.getByRole("group", { name: "Status" });
    for (const label of [
      "All",
      "Running",
      "Awaiting approval",
      "Awaiting you",
      "Done",
      "Failed",
      "Canceled",
    ]) {
      expect(within(statusGroup).getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("no longer offers Active or Archived inside the filter panel", () => {
    // Scope is a peer chip of the list, not a second half of the panel: two
    // controls for one view would be two chances to disagree.
    setup();
    fireEvent.click(trigger());
    const panel = document.getElementById(trigger().getAttribute("aria-controls")!)!;
    expect(within(panel).queryByRole("button", { name: "Active" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "Archived" })).toBeNull();
    expect(within(panel).queryByText("Projects")).toBeNull();
  });

  it("offers no clear control when nothing is applied", () => {
    setup();
    fireEvent.click(trigger());
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("says how many filters are applied instead of a bare number", () => {
    // The badge is aria-hidden; without this sentence a screen reader would
    // read "Failed 1" and never say what the 1 counts.
    setup({ status: "failed" });
    expect(trigger().textContent).toContain("Filters applied: 1");
  });

  it("points aria-controls at the panel only while it is open", () => {
    setup();
    // A dangling reference is worse than none: it tells assistive tech there
    // is a region where there is not.
    const button = trigger();
    expect(button.getAttribute("aria-controls")).toBeNull();
    fireEvent.click(button);
    const panel = document.getElementById(button.getAttribute("aria-controls")!);
    expect(panel).toBeTruthy();
    expect(panel!.textContent).toContain("Status");
  });

  it("closes on Escape and hands focus back to the trigger", () => {
    setup({ status: "running" });
    const button = trigger();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(screen.getByRole("group", { name: "Status" }), { key: "Escape" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
    // The panel leaves the tab order with Escape; the always-visible chips
    // stay, because they are the list's view, not part of the panel.
    expect(screen.queryByRole("group", { name: "Status" })).toBeNull();
    expect(chip("Running")).toBeTruthy();
  });
});

describe("normalizeStatusFilter", () => {
  it("keeps the six statuses the list offers", () => {
    expect(normalizeStatusFilter("running")).toBe("running");
    expect(normalizeStatusFilter("waiting_approval")).toBe("waiting_approval");
    expect(normalizeStatusFilter("waiting_input")).toBe("waiting_input");
    expect(normalizeStatusFilter("succeeded")).toBe("succeeded");
    expect(normalizeStatusFilter("failed")).toBe("failed");
    expect(normalizeStatusFilter("canceled")).toBe("canceled");
  });

  it("treats anything else as no filter", () => {
    // A stale bookmark (`?status=queued`) must show the list, not an empty page
    // that says no conversation has that status.
    expect(normalizeStatusFilter(null)).toBe("");
    expect(normalizeStatusFilter("queued")).toBe("");
    expect(normalizeStatusFilter("")).toBe("");
  });
});

describe("normalizeScopeFilter", () => {
  it("reads archived and defaults everything else to active", () => {
    expect(normalizeScopeFilter("archived")).toBe("archived");
    expect(normalizeScopeFilter("active")).toBe("active");
    expect(normalizeScopeFilter(null)).toBe("active");
    expect(normalizeScopeFilter("everything")).toBe("active");
  });
});
