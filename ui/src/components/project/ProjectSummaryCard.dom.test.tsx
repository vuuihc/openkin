// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { Project } from "../../api/client";
import { useLeaveGuard } from "../../hooks/useLeaveGuard";
import { setLocale, t as tr } from "../../i18n";
import { resetLeaveGuard } from "../../lib/leaveGuard";
import ProjectSummaryCard from "./ProjectSummaryCard";

/** A draft with an edited form: it refuses the departure until it is clean. */
const guard = { allow: false };

function GuardedDraft() {
  useLeaveGuard(() => guard.allow, true);
  return null;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

const project: Project = {
  id: "p1",
  name: "Alpha",
  mode: "ship",
  status: "active",
  created_at: 0,
  updated_at: 0,
  last_active_at: 0,
};

function renderCard() {
  return render(
    <MemoryRouter>
      <GuardedDraft />
      <ProjectSummaryCard project={project} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setLocale("en");
  guard.allow = false;
  resetLeaveGuard();
});

describe("the project summary card", () => {
  it("marks the draft's summary as reading content", () => {
    // At 1100 the floating approval card covered this summary's right half on
    // `/new`. The whole card is marked, including the cover link: the link is
    // the half the card sat on, and it is the reader's next action.
    const view = renderCard();
    const marked = view.container.querySelector("[data-kin-reading]");

    expect(marked).not.toBeNull();
    expect(marked?.contains(screen.getByRole("link", { name: tr("newChat.openOnePager") }))).toBe(
      true,
    );
  });

  it("the draft summary opens the project-filtered list", async () => {
    // The cover it used to open is retired: the summary is edited from the
    // project's row on the one list, and the link goes to that narrowed list.
    const user = userEvent.setup();
    renderCard();
    const link = screen.getByRole("link", { name: tr("newChat.openOnePager") }) as HTMLElement;

    expect(link.getAttribute("href")).toBe("/sessions?project=p1");

    // A dirty draft owns the departure: the guard refuses and the URL stays.
    await user.click(link);
    expect(screen.getByTestId("location").textContent).toBe("/");

    guard.allow = true;
    await user.click(link);
    await waitFor(() =>
      expect(screen.getByTestId("location").textContent).toBe("/sessions?project=p1"),
    );
  });

  it("keeps the summary chip thumb-sized on a coarse tablet and compact on the Mac", () => {
    renderCard();
    const link = screen.getByRole("link", { name: tr("newChat.openOnePager") }) as HTMLElement;

    expect(link.getAttribute("href")).toBe("/sessions?project=p1");

    const classes = link.className.split(/\s+/);
    // `min-height` does not apply to a non-replaced inline box, so the display
    // class carries the floor as much as `min-h-11` does. `sm:min-h-0` still
    // drops the phone floor from 640px up, and `.touch-floor` is the one chip
    // that opts back in on a coarse pointer between 640 and 1023.98. This
    // asserts the wiring; the rendered 44px box is the measured proof, not
    // this test.
    expect(classes.some((c) => c === "inline-flex" || c === "flex")).toBe(true);
    expect(classes).toContain("min-h-11");
    expect(classes).toContain("sm:min-h-0");
    expect(classes).toContain("touch-floor");

    // The chip keeps its current shape; only its hit area grows on a phone.
    expect(classes).toContain("rounded-lg");
    expect(classes).toContain("text-body");
  });
});
