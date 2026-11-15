// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { Project } from "../../api/client";
import { setLocale } from "../../i18n";
import ProjectCover, { NewChatControl } from "./ProjectCover";

const project: Project = {
  id: "p1",
  name: "alpha",
  mode: "ship",
  status: "active",
  created_at: 1,
  updated_at: 2,
  last_active_at: 3,
  roots: ["/work/alpha"],
};

function renderCover(overrides: Partial<ComponentProps<typeof ProjectCover>> = {}) {
  const props: ComponentProps<typeof ProjectCover> = {
    project,
    root: "/work/alpha",
    now: 1_000,
    canStartChat: true,
    onBack: vi.fn(),
    onModeChange: vi.fn(),
    onStartChat: vi.fn(),
    ...overrides,
  };
  const view = render(
    <MemoryRouter>
      <ProjectCover {...props} />
    </MemoryRouter>,
  );
  return { ...view, props };
}

beforeEach(() => {
  setLocale("en");
});

describe("the project cover header", () => {
  it("renders the project name and the continue affordance", () => {
    render(
      <MemoryRouter>
        <ProjectCover
          project={project}
          root="/work/alpha"
          now={1_000}
          canStartChat
          onBack={vi.fn()}
          onModeChange={vi.fn()}
          onStartChat={vi.fn()}
        />
        <NewChatControl href="/new?cwd=%2Fwork%2Falpha" disabledReason="" fullWidth={false} />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "alpha" })).toBeTruthy();
    expect(screen.getByText("/work/alpha")).toBeTruthy();
    expect(screen.getByRole("link", { name: "New chat" }).getAttribute("href")).toBe(
      "/new?cwd=%2Fwork%2Falpha",
    );
  });

  it("uses the cached cover when one exists and shows the loading state otherwise", () => {
    const { rerender } = renderCover();
    expect(screen.getByRole("heading", { level: 1, name: "alpha" })).toBeTruthy();

    rerender(
      <MemoryRouter>
        <ProjectCover
          project={null}
          loading
          now={1_000}
          canStartChat={false}
          onBack={vi.fn()}
          onModeChange={vi.fn()}
          onStartChat={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.getByTestId("project-cover-loading")).toBeTruthy();
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
  });

  it("⌘Enter starts a chat", () => {
    const { props } = renderCover();

    fireEvent.keyDown(window, { key: "Enter", metaKey: true });

    expect(props.onStartChat).toHaveBeenCalledTimes(1);
  });

  it("Esc calls onBack", async () => {
    const user = userEvent.setup();
    const { props } = renderCover();

    await user.keyboard("{Escape}");

    expect(props.onBack).toHaveBeenCalledTimes(1);
  });
});
