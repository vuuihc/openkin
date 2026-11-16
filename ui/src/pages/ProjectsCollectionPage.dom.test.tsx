// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { listProjects, type Project } from "../api/client";
import { setLocale, t } from "../i18n";
import ProjectsCollectionPage from "./ProjectsCollectionPage";

/**
 * The `/projects` area root is the third area root beside Chats and Routines:
 * one page frame, one title, full-width drill-in rows, and the same three
 * answers (loading / empty / failed) in the same place.
 *
 * jsdom cannot see a media query, so "the shell bar owns the title at 390" is
 * held by the header block's `hidden md:block` contract rather than by a width.
 */

const fixtures = vi.hoisted(() => ({
  projects: [] as Project[],
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    listProjects: vi.fn(async () => fixtures.projects),
  };
});

const PROJECT: Project = {
  id: "p1",
  name: "alpha",
  mode: "ship",
  status: "active",
  created_at: 1,
  updated_at: 2,
  last_active_at: 3,
  roots: ["/work/alpha"],
};

const SECOND: Project = {
  ...PROJECT,
  id: "p2",
  name: "beta",
  mode: "learn",
  roots: ["/work/beta"],
};

const ROOTLESS: Project = {
  ...PROJECT,
  id: "p3",
  name: "gamma",
  roots: [],
};

function renderPage() {
  return render(
    <MemoryRouter>
      <ProjectsCollectionPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setLocale("en");
  fixtures.projects = [];
});

describe("the projects collection", () => {
  it("names the area once at phone width", async () => {
    fixtures.projects = [PROJECT];
    renderPage();

    const heading = await screen.findByRole("heading", { level: 1, name: "Projects" });
    // One `h1` in the page. At 390 the shell's `MobileHeader` already names the
    // area, so this one lives in the header block the phone hides; at 1100 the
    // block is what the page shows.
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const header = heading.parentElement;
    expect(header?.className).toContain("hidden");
    expect(header?.className).toContain("md:block");
    expect(heading.className).toContain("text-hero");
  });

  it("does not nest a card inside the page", async () => {
    fixtures.projects = [PROJECT, SECOND, ROOTLESS];
    const { container } = renderPage();

    const links = await screen.findAllByRole("link");
    expect(links).toHaveLength(3);
    // No card-in-card: the rows sit on the page surface, not in a `MobileCard`.
    expect(container.querySelector(".kin-card")).toBeNull();
    const list = container.querySelector("[data-projects-list]");
    expect(list?.children).toHaveLength(3);
    for (const link of links) {
      // Drill-in is a link, not a button (`IA.md` requires the URL).
      expect(link.tagName).toBe("A");
      expect(link.parentElement).toBe(list);
    }
  });

  it("keeps the row content", async () => {
    fixtures.projects = [PROJECT, ROOTLESS];
    renderPage();

    const alpha = await screen.findByRole("link", { name: /alpha/ });
    expect(alpha.getAttribute("href")).toBe("/projects/p1");
    expect(alpha.textContent).toContain("alpha");
    expect(alpha.textContent).toContain(t("projects.modeShip"));
    expect(alpha.textContent).toContain("/work/alpha");
    expect(alpha.querySelector("svg")).not.toBeNull();

    // No roots: the mode stands alone rather than leaving a dangling separator.
    const gamma = screen.getByRole("link", { name: /gamma/ });
    expect(gamma.textContent).toContain(t("projects.modeShip"));
    expect(gamma.textContent).not.toContain("·");
    expect(gamma.querySelector("svg")).not.toBeNull();
  });

  it("keeps the three states apart", async () => {
    // Loading: the read has not answered yet.
    vi.mocked(listProjects).mockImplementationOnce(() => new Promise<Project[]>(() => {}));
    const loading = renderPage();
    expect(screen.getByText(t("common.loading"))).toBeTruthy();
    expect(screen.queryByText(t("projects.empty"))).toBeNull();
    loading.unmount();

    // Failed: an error is not "no projects yet", and it is not still loading.
    vi.mocked(listProjects).mockRejectedValueOnce(new Error("offline"));
    const failed = renderPage();
    expect(await screen.findByText(t("projects.loadFailed"))).toBeTruthy();
    expect(screen.queryByText(t("projects.empty"))).toBeNull();
    expect(screen.queryByText(t("common.loading"))).toBeNull();
    failed.unmount();

    // Empty: a successful read with nothing in it.
    fixtures.projects = [];
    renderPage();
    expect(await screen.findByText(t("projects.empty"))).toBeTruthy();
    expect(screen.queryByText(t("projects.loadFailed"))).toBeNull();
    expect(screen.queryByText(t("common.loading"))).toBeNull();
  });

  it("keeps one scrolling region", async () => {
    fixtures.projects = [PROJECT];
    const { container } = renderPage();

    await screen.findByRole("link", { name: /alpha/ });
    const root = container.firstElementChild;
    expect(root?.className).toContain("overflow-y-auto");
    expect(root?.className).toContain("kin-scroll");
    // The area root owns the scroll body; nothing inside it opens a second.
    expect(container.querySelectorAll(".overflow-y-auto")).toHaveLength(1);
  });

  it("labels the mode in the reader's language, not the raw enum", async () => {
    setLocale("zh");
    fixtures.projects = [PROJECT];
    renderPage();

    const link = await screen.findByRole("link", { name: /alpha/ });
    expect(link.textContent).toContain("交付");
    expect(link.textContent).not.toContain("ship");
  });
});
