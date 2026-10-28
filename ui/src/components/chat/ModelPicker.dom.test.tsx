// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setLocale } from "../../i18n";
import { CUSTOM_MODEL_ID } from "../../lib/agentModels";
import ModelPicker from "./ModelPicker";

/**
 * The picker hands the choice control a *selected id*, and the control marks
 * whichever option carries it. A custom model id matches no option, and picking
 * "Custom" stores "" — which is the id of the Default row. Passing the raw
 * value to the control therefore marks the wrong row (or none) while the chip
 * says something else. The control itself is stubbed here: what this test pins
 * is the contract with it, not the popover/sheet rendering.
 */
vi.mock("../ui/SearchSelect", () => ({
  default: (props: {
    label: string;
    value: string;
    display?: string;
    onChange: (id: string) => void;
  }) => (
    <>
      <button
        type="button"
        data-testid="trigger"
        data-value={props.value}
        data-display={props.display ?? ""}
        // The literal, because a `vi.mock` factory is hoisted above imports;
        // the assertions below use `CUSTOM_MODEL_ID` so a rename shows up as a
        // failing assertion rather than a silently inert stub.
        onClick={() => props.onChange("__custom__")}
      >
        {props.label}
      </button>
      <button type="button" data-testid="pick" onClick={() => props.onChange("opus")}>
        pick opus
      </button>
    </>
  ),
}));

const MODELS = [{ id: "opus", label: "Opus" }];

function setup(value: string, onChange = vi.fn()) {
  render(<ModelPicker value={value} models={MODELS} compact onChange={onChange} />);
  return { trigger: screen.getByTestId("trigger"), onChange };
}

beforeEach(() => {
  setLocale("en");
});

describe("ModelPicker compact sheet selection", () => {
  it("marks the custom row for a model the catalog does not list", () => {
    const { trigger } = setup("my-model");
    expect(trigger.dataset.value).toBe(CUSTOM_MODEL_ID);
    // The chip still names the model itself, not the menu entry.
    expect(trigger.dataset.display).toBe("my-model");
  });

  it("marks the default row when no model is selected", () => {
    const { trigger } = setup("");
    expect(trigger.dataset.value).toBe("");
    expect(trigger.dataset.display).toBe("");
  });

  it("marks the custom row after Custom is chosen, not Default", async () => {
    const { trigger, onChange } = setup("");
    await userEvent.click(trigger);
    // Choosing Custom clears the selection so the user can type an id.
    expect(onChange).toHaveBeenCalledWith("");
    expect(trigger.dataset.value).toBe(CUSTOM_MODEL_ID);
    expect(trigger.dataset.display).toBe("Custom model…");
  });

  it("passes a listed model id through unchanged", async () => {
    const { trigger, onChange } = setup("");
    await userEvent.click(screen.getByTestId("pick"));
    expect(onChange).toHaveBeenCalledWith("opus");
    expect(trigger.dataset.value).toBe("");
  });
});
