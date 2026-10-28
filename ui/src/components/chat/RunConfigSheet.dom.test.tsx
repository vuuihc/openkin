// @vitest-environment jsdom
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import RunConfigControl, { type RunConfigControlProps } from "./RunConfigSheet";

const MODELS = [
  { id: "opus", label: "Opus", tier: "flagship" },
  { id: "sonnet", label: "Sonnet" },
];

function setup(overrides: Partial<RunConfigControlProps> = {}) {
  const onModelChange = vi.fn();
  const onPermissionChange = vi.fn();
  const props: RunConfigControlProps = {
    agentName: "Claude Code",
    agentAvatar: { initials: "C", className: "bg-kin-agent-claude" },
    model: "sonnet",
    models: MODELS,
    onModelChange,
    permission: "default",
    permissionModes: ["default", "accept_edits", "yolo"],
    onPermissionChange,
    ...overrides,
  };
  // The control is controlled by its parent in the app; a static prop here
  // would keep the custom field showing the old value while the user types,
  // which is not a state the real composer can be in.
  function Harness() {
    const [model, setModel] = useState(props.model);
    const [permission, setPermission] = useState<string>(props.permission);
    return (
      <RunConfigControl
        {...props}
        model={model}
        permission={permission}
        onModelChange={(id) => {
          onModelChange(id);
          setModel(id);
        }}
        onPermissionChange={(mode) => {
          onPermissionChange(mode);
          setPermission(mode);
        }}
      />
    );
  }
  render(<Harness />);
  return { onModelChange, onPermissionChange };
}

async function openSheet() {
  await userEvent.click(screen.getByRole("button", { name: /^Run settings/ }));
  return screen.getByRole("dialog", { name: "Run settings" });
}

beforeEach(() => {
  setLocale("en");
});

describe("RunConfigControl", () => {
  it("names the agent, the model and the mode on the face", () => {
    setup();
    expect(screen.getByRole("button", { name: /^Run settings/ }).textContent).toContain("Sonnet");
    expect(screen.getByRole("button", { name: /^Run settings/ }).textContent).toContain("Ask");
  });

  it("opens the sheet with the agent read-only and the two pickers", async () => {
    setup();
    await openSheet();
    expect(screen.getByText("Claude Code")).toBeTruthy();
    // The agent is a fact once the session exists, not a control.
    expect(screen.queryByRole("button", { name: "Agent" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Model/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Permissions/ })).toBeTruthy();
  });

  it("marks the current model and picks a new one from the inline list", async () => {
    const { onModelChange } = setup();
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Model/ }));

    const list = screen.getByRole("listbox", { name: "Model" });
    expect(list).toBeTruthy();
    expect(screen.getByRole("option", { name: /Sonnet/ }).getAttribute("aria-selected")).toBe(
      "true",
    );

    await userEvent.click(screen.getByRole("option", { name: /Opus/ }));
    expect(onModelChange).toHaveBeenCalledWith("opus");
    // Choosing a value closes the expansion; the sheet stays.
    expect(screen.queryByRole("listbox", { name: "Model" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBeTruthy();
  });

  it("keeps a custom model id reachable behind the custom row", async () => {
    const { onModelChange } = setup();
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Model/ }));
    await userEvent.click(screen.getByRole("option", { name: "Custom model…" }));

    expect(onModelChange).toHaveBeenCalledWith("");
    const field = screen.getByLabelText("Custom model ID");
    await userEvent.type(field, "my-model");
    expect(onModelChange).toHaveBeenLastCalledWith("my-model");
    // The expansion stays open so the field is not pulled out from under the
    // caret while it is being typed into.
    expect(screen.getByRole("listbox", { name: "Model" })).toBeTruthy();
  });

  it("closes the expansion on Escape, and the sheet on the next one", async () => {
    setup();
    await openSheet();
    const trigger = screen.getByRole("button", { name: /^Model/ });
    await userEvent.click(trigger);
    expect(screen.getByRole("listbox", { name: "Model" })).toBeTruthy();

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox", { name: "Model" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Run settings" })).toBeTruthy();
    // Focus goes back to the row that closed, so the keyboard stays where the
    // change was about to be made.
    expect(document.activeElement).toBe(trigger);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Run settings" })).toBeNull();
  });

  it("walks out of the option list and back into the search field", async () => {
    // More than six models is what makes the list long enough to grow a field.
    const many = Array.from({ length: 8 }, (_, index) => ({
      id: `m${index}`,
      label: `Model ${index}`,
    }));
    setup({ models: many, model: "m0" });
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Model/ }));

    const search = screen.getByLabelText("Search models");
    await userEvent.click(search);
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getAllByRole("option")[0]);

    // Up from the first option is the way back to the field ArrowDown left —
    // otherwise the pair is a one-way trip and the field keeps the caret.
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(search);
  });

  it("takes the first match when Enter is pressed in the field", async () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      id: `m${index}`,
      label: `Model ${index}`,
    }));
    const { onModelChange } = setup({ models: many, model: "m0" });
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Model/ }));

    await userEvent.type(screen.getByLabelText("Search models"), "Model 5");
    await userEvent.keyboard("{Enter}");
    // Filtering down to the row you want and pressing Enter takes it, the way
    // the desktop `SearchSelect` behaves.
    expect(onModelChange).toHaveBeenCalledWith("m5");
    expect(screen.queryByRole("listbox", { name: "Model" })).toBeNull();
  });

  it("changes the permission mode", async () => {
    const { onPermissionChange } = setup();
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Permissions/ }));
    await userEvent.click(screen.getByRole("option", { name: /YOLO/ }));
    expect(onPermissionChange).toHaveBeenCalledWith("yolo");
    expect(screen.queryByRole("listbox", { name: "Permissions" })).toBeNull();
  });

  it("only offers the modes the machine actually runs", async () => {
    setup({ permissionModes: ["default"] });
    await openSheet();
    await userEvent.click(screen.getByRole("button", { name: /^Permissions/ }));
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByRole("option", { name: /YOLO/ })).toBeNull();
  });
});
