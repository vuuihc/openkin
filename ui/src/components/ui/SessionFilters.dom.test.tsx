// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { setLocale } from "../../i18n";
import SessionFilters, {
  normalizeScopeFilter,
  normalizeStatusFilter,
  type SessionScopeFilter,
  type SessionStatusFilter,
} from "./SessionFilters";

/**
 * The list's filter panel.
 *
 * Two rules are worth a DOM test because they are invisible in the pure
 * helpers: the trigger must say what is applied (a filter the list obeys but
 * the control does not show reads as "rows are missing"), and clearing must
 * hand back the *unfiltered* pair in one call — the page writes the URL per
 * change, so two calls would leave a history entry and a frame of half-state.
 */

const trigger = () => screen.getByRole("button", { expanded: false });

function setup(status: SessionStatusFilter = "", scope: SessionScopeFilter = "active") {
  const onChange = vi.fn();
  render(<SessionFilters status={status} scope={scope} onChange={onChange} />);
  return { onChange };
}

beforeEach(() => {
  setLocale("en");
});

describe("SessionFilters", () => {
  it("starts closed, showing only the label", () => {
    setup();
    expect(trigger().textContent).toContain("Filter");
    // The options are not in the DOM until it opens: a closed panel that still
    // rendered every chip would put ten buttons in the tab order for a control
    // the person has not opened.
    expect(screen.queryByRole("button", { name: "Running" })).toBeNull();
  });

  it("names every applied filter on the closed trigger", () => {
    setup("running", "archived");
    expect(trigger().textContent).toContain("Running");
    expect(trigger().textContent).toContain("Archived");
  });

  it("reports a status choice with the scope unchanged", () => {
    const { onChange } = setup("", "archived");
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "Failed" }));
    expect(onChange).toHaveBeenCalledWith({ status: "failed", scope: "archived" });
  });

  it("toggles a chosen status off rather than leaving it stuck", () => {
    const { onChange } = setup("running");
    fireEvent.click(trigger());
    // The trigger carries the applied status too, with its count ("Running 1"),
    // so the chip is the button whose accessible name is exactly the label.
    fireEvent.click(screen.getByRole("button", { name: "Running" }));
    expect(onChange).toHaveBeenCalledWith({ status: "", scope: "active" });
  });

  it("clears both halves in one call", () => {
    const { onChange } = setup("failed", "archived");
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ status: "", scope: "active" });
  });

  it("offers every status a person can look for, including canceled", () => {
    // Canceled is the one status the row dot draws nothing for, so the chip is
    // the only way to find a canceled run in a list that shows a hundred rows.
    setup("failed", "archived");
    fireEvent.click(trigger());
    for (const label of [
      "All",
      "Running",
      "Awaiting approval",
      "Awaiting you",
      "Done",
      "Failed",
      "Canceled",
      "Active",
      "Archived",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("offers no clear control when nothing is applied", () => {
    setup();
    fireEvent.click(trigger());
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("says how many filters are applied instead of a bare number", () => {
    // The badge is aria-hidden; without this sentence a screen reader would
    // read "Failed · Archived 2" and never say what the 2 counts.
    setup("failed", "archived");
    expect(trigger().textContent).toContain("Filters applied: 2");
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
    setup("running");
    const button = trigger();
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(screen.getByRole("group", { name: "Status" }), { key: "Escape" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
    // The chips leave the tab order with the panel.
    expect(screen.queryByRole("button", { name: "Running" })).toBeNull();
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
