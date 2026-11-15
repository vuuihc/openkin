// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OnePager } from "../../api/client";
import { setLocale } from "../../i18n";
import ProjectOnePager from "./ProjectOnePager";

const conflict: OnePager = {
  project_id: "p1",
  markdown: "# alpha\n\n## Current Focus\ntheir line\n",
  updated_at: 200,
  one_pager_summary: { focus: "their line" },
};

function renderOnePager(overrides: Partial<ComponentProps<typeof ProjectOnePager>> = {}) {
  const props: ComponentProps<typeof ProjectOnePager> = {
    titleId: "summary",
    loaded: true,
    loading: false,
    loadError: null,
    summaryText: "ship the first slice",
    saving: false,
    saved: false,
    conflict: null,
    offline: false,
    onRetry: vi.fn(),
    onSave: vi.fn(),
    onBeginEdit: vi.fn(),
    onKeepMine: vi.fn(),
    onTakeTheirs: vi.fn(),
    onDismissConflict: vi.fn(),
    onEditingChange: vi.fn(),
    onDirtyChange: vi.fn(),
    ...overrides,
  };
  const view = render(<ProjectOnePager {...props} />);
  return { ...view, props };
}

beforeEach(() => {
  setLocale("en");
});

describe("the project one-pager section", () => {
  it("renders the summary, loading, error and conflict states", async () => {
    const user = userEvent.setup();
    const view = renderOnePager();
    expect(screen.getByText("ship the first slice")).toBeTruthy();

    view.rerender(<ProjectOnePager {...view.props} loaded={false} loading summaryText="" />);
    expect(document.querySelector(".animate-pulse")).toBeTruthy();

    view.rerender(
      <ProjectOnePager
        {...view.props}
        loaded={false}
        loading={false}
        loadError="The summary is unavailable right now"
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("The summary is unavailable right now");

    view.rerender(
      <ProjectOnePager {...view.props} loaded conflict={conflict} summaryText="their line" />,
    );
    // The conflict is a state of the open editor, like the page's.
    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("alert").textContent).toContain(
      "This cover changed elsewhere. Their version:",
    );
  });

  it("saving calls onSave with the edited body", async () => {
    const user = userEvent.setup();
    const { props } = renderOnePager();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const field = screen.getByRole("textbox", { name: "One-line summary" });
    await user.clear(field);
    await user.type(field, "edited line");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(props.onSave).toHaveBeenCalledWith("edited line");
  });
});
