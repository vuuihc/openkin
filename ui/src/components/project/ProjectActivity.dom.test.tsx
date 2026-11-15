// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { setLocale } from "../../i18n";
import ProjectActivity from "./ProjectActivity";

function renderActivity(overrides: Partial<ComponentProps<typeof ProjectActivity>> = {}) {
  const props: ComponentProps<typeof ProjectActivity> = {
    titleId: "recent",
    activity: null,
    loading: false,
    ready: true,
    error: null,
    partial: false,
    lastCommit: null,
    importAt: null,
    windowDays: 14,
    now: 1_000,
    onRetry: vi.fn(),
    onOpen: vi.fn(),
    ...overrides,
  };
  const view = render(<ProjectActivity {...props} />);
  return { ...view, props };
}

beforeEach(() => {
  setLocale("en");
});

describe("the project activity section", () => {
  it("renders the activity list when loaded", () => {
    const onOpen = vi.fn();
    renderActivity({
      activity: { key: "c1", at: 500, title: "newest chat", agentId: "kin", remote: false },
      onOpen,
    });

    const row = screen.getByRole("button", { name: /newest chat/ });
    row.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("renders the partial-activity notice when activityPartial is true", () => {
    renderActivity({ partial: true });

    expect(screen.getByRole("status").textContent).toBe(
      "Some imported sessions could not be loaded.",
    );
  });
});
