// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DEFAULT_LOCALE, setLocale } from "../../i18n";
import type { WorkspaceGeneration } from "../../api/client";
import WorkspaceGenerationPicker from "./WorkspaceGenerationPicker";

/**
 * The generation trigger names the workspace the viewer is showing. Its
 * children are elements (a label and a lifecycle badge), so the facade cannot
 * derive an accessible name from them: the trigger has to carry the name
 * explicitly or it ships as an unnamed button. Its menu rows stay row hit
 * areas; only the trigger is an action.
 */

function generation(overrides: Partial<WorkspaceGeneration> = {}): WorkspaceGeneration {
  return {
    id: "g2",
    task_id: "task-1",
    generation: 2,
    state: "active",
    source_root: "/work",
    scope: "all",
    created_at: 1,
    updated_at: 2,
    ...overrides,
  };
}

beforeEach(() => {
  setLocale("en");
});

afterEach(() => {
  setLocale(DEFAULT_LOCALE);
});

describe("the generation picker's trigger", () => {
  it("names the generation trigger and puts it on the facade", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <WorkspaceGenerationPicker
        generations={[generation()]}
        loading={false}
        selectedId="g2"
        onChange={onChange}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Workspace 2" });
    expect(trigger.getAttribute("aria-label")).toBe("Workspace 2");
    expect(trigger.textContent).toContain("Workspace 2");
    expect(trigger.className).toContain("kin-btn");
    expect(trigger.className).toContain("kin-btn-secondary");

    await user.click(trigger);
    // The option rows keep their own row shape; selecting one is unchanged.
    const option = screen.getByRole("button", { name: /Workspace 2\s*active/ });
    await user.click(option);
    expect(onChange).toHaveBeenCalledWith("g2");
  });
});
