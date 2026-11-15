// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { Project } from "../api/client";
import { setLocale } from "../i18n";
import ProjectsCollectionPage from "./ProjectsCollectionPage";

/**
 * N2 UX rework: a collection row is a drill-in row, not static text.
 *
 * The row shape is the phone's `MobileRow` shape rendered as a link: title,
 * secondary line (mode · root), and the trailing chevron that says "this opens
 * the cover". Asserting the accessible name and the chevron together is what
 * keeps a future restyle from turning the row back into a plain label.
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

beforeEach(() => {
  setLocale("en");
  fixtures.projects = [];
});

describe("the projects collection", () => {
  it("renders a project as a drill-in link with its mode and root", async () => {
    fixtures.projects = [PROJECT];
    render(
      <MemoryRouter>
        <ProjectsCollectionPage />
      </MemoryRouter>,
    );

    const link = await screen.findByRole("link", { name: /alpha/ });
    expect(link.getAttribute("href")).toBe("/projects/p1");
    expect(link.textContent).toContain("ship");
    expect(link.textContent).toContain("/work/alpha");
    expect(link.querySelector("svg")).not.toBeNull();
  });
});
