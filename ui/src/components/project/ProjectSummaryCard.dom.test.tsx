// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Project } from "../../api/client";
import { setLocale, t as tr } from "../../i18n";
import ProjectSummaryCard from "./ProjectSummaryCard";

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
      <ProjectSummaryCard project={project} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setLocale("en");
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

  it("gives the cover link the phone touch floor", () => {
    renderCard();
    const link = screen.getByRole("link", { name: tr("newChat.openOnePager") }) as HTMLElement;

    expect(link.getAttribute("href")).toBe("/projects/p1");

    const classes = link.className.split(/\s+/);
    // `min-height` does not apply to a non-replaced inline box, so the display
    // class carries the floor as much as `min-h-11` does. At 640px and up the
    // chip drops the floor and stays as compact as it is on the Mac today.
    expect(classes.some((c) => c === "inline-flex" || c === "flex")).toBe(true);
    expect(classes).toContain("min-h-11");
    expect(classes).toContain("sm:min-h-0");

    // The chip keeps its current shape; only its hit area grows on a phone.
    expect(classes).toContain("rounded-lg");
    expect(classes).toContain("text-body");
  });
});
