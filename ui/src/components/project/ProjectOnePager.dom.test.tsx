// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { act, render, screen } from "@testing-library/react";
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

  it("returns focus to the Edit button when a save succeeds", async () => {
    const user = userEvent.setup();
    const view = renderOnePager();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "One-line summary" }));

    view.rerender(<ProjectOnePager {...view.props} saved />);
    // The Edit button is re-rendered by the same state change, so the focus
    // returns on the next frame, not synchronously.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit" }));
  });

  it("moves edit save cancel and the conflict choices onto the facade", async () => {
    const user = userEvent.setup();
    const view = renderOnePager();

    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit.className).toContain("kin-btn");
    await user.click(edit);
    expect(view.props.onBeginEdit).toHaveBeenCalledTimes(1);

    const save = screen.getByRole("button", { name: "Save" });
    expect(save.className).toContain("kin-btn");
    await user.click(save);
    expect(view.props.onSave).toHaveBeenCalledTimes(1);

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.className).toContain("kin-btn");
    await user.click(cancel);
    expect(view.props.onDismissConflict).toHaveBeenCalledTimes(1);

    view.unmount();

    // The conflict choices sit in the same editor, once the page reports a 409.
    const keepView = renderOnePager({ conflict, summaryText: "their line" });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const keep = screen.getByRole("button", { name: "Keep mine and overwrite" });
    expect(keep.className).toContain("kin-btn");
    await user.click(keep);
    expect(keepView.props.onKeepMine).toHaveBeenCalledTimes(1);

    const take = screen.getByRole("button", { name: "Use their version" });
    expect(take.className).toContain("kin-btn");
    await user.click(take);
    expect(keepView.props.onTakeTheirs).toHaveBeenCalledTimes(1);

    keepView.unmount();

    const dismissView = renderOnePager({ conflict, summaryText: "their line" });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dismiss = screen.getByRole("button", { name: "Keep editing" });
    expect(dismiss.className).toContain("kin-btn");
    await user.click(dismiss);
    expect(dismissView.props.onDismissConflict).toHaveBeenCalledTimes(1);
  });

  it("gives the section exactly one filled action per state", async () => {
    const user = userEvent.setup();
    const view = renderOnePager();
    const section = screen.getByRole("heading", { name: "One-line summary" }).closest("section")!;

    // Reading: Edit is a bordered peer, so the section holds no filled action.
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit.className).toContain("kin-btn-secondary");
    expect(section.querySelectorAll(".kin-btn-primary").length).toBe(0);

    // Editing a clean draft: Save is the one filled action.
    await user.click(edit);
    expect(section.querySelectorAll(".kin-btn-primary").length).toBe(1);
    expect(screen.getByRole("button", { name: "Save" }).className).toContain("kin-btn-primary");

    // A conflict: exactly one filled choice, and it is Keep mine.
    view.rerender(<ProjectOnePager {...view.props} conflict={conflict} summaryText="their line" />);
    const choices = section.querySelectorAll(".kin-btn-primary");
    expect(choices.length).toBe(1);
    expect(choices[0].textContent).toBe("Keep mine and overwrite");
  });

  it("keeps the 44px touch floor on a phone", async () => {
    const user = userEvent.setup();
    const view = renderOnePager();
    await user.click(screen.getByRole("button", { name: "Edit" }));

    for (const control of view.container.querySelectorAll("button")) {
      // The facade always carries `min-h-11`; the page must not override it to
      // zero, which would drop the control under the 44px floor on touch.
      expect(control.className).toContain("min-h-11");
      expect(control.className).not.toMatch(/(^|\s)min-h-0(\s|$)/);
    }

    const section = screen.getByRole("heading", { name: "One-line summary" }).closest("section")!;
    // No arbitrary pixel width that could overflow a 390px viewport.
    expect(section.innerHTML).not.toContain("w-[");
  });

  it("keeps focus in the editor while a save is in flight", async () => {
    const user = userEvent.setup();
    const view = renderOnePager();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const field = screen.getByRole("textbox", { name: "One-line summary" });
    expect(document.activeElement).toBe(field);

    // Saving is not success: the editor stays open and keeps the caret until
    // the page reports that the save landed.
    view.rerender(<ProjectOnePager {...view.props} saving />);

    expect(screen.getByRole("textbox", { name: "One-line summary" })).toBe(field);
    expect(document.activeElement).toBe(field);
  });
});
