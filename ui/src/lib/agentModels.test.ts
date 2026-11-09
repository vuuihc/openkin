import { describe, expect, it } from "vitest";
import {
  CUSTOM_MODEL_ID,
  isListedModel,
  modelPickTarget,
  modelPickerOptions,
  modelPickerSelection,
  normalizeModelSelection,
} from "./agentModels";

describe("agent model choices", () => {
  it("keeps arbitrary custom model IDs usable", () => {
    const models = [{ id: "sonnet" }];
    expect(isListedModel(models, "sonnet")).toBe(true);
    expect(isListedModel(models, "proxy/preview-model")).toBe(false);
    expect(normalizeModelSelection(" proxy/preview-model ")).toBe("proxy/preview-model");
  });

  it("preserves empty default semantics", () => {
    expect(normalizeModelSelection("  ")).toBe("");
  });

  it("marks default and custom as different rows", () => {
    // Both store "" but they are not the same choice: Default means "whatever
    // the CLI picks", Custom means "the id that is in the box".
    expect(modelPickerSelection("", false)).toBe("");
    expect(modelPickerSelection("claude-opus-5-5", false)).toBe("claude-opus-5-5");
    expect(modelPickerSelection("", true)).toBe(CUSTOM_MODEL_ID);
    expect(modelPickerSelection("claude-opus-5-5", true)).toBe(CUSTOM_MODEL_ID);
  });

  it("round-trips a row through pick", () => {
    expect(modelPickTarget(CUSTOM_MODEL_ID)).toEqual({ custom: true, value: "" });
    expect(modelPickTarget("")).toEqual({ custom: false, value: "" });
    expect(modelPickTarget("claude-opus-5-5")).toEqual({
      custom: false,
      value: "claude-opus-5-5",
    });
  });

  it("lists Default, the catalog, then Custom", () => {
    expect(
      modelPickerOptions([{ id: "gw/opus", label: "Opus", tier: "strong" }, { id: "sonnet" }], {
        default: "Default",
        custom: "Custom",
      }),
    ).toEqual([
      { id: "", label: "Default" },
      { id: "gw/opus", label: "Opus", detail: "strong · gw", group: "gw" },
      { id: "sonnet", label: "sonnet" },
      { id: CUSTOM_MODEL_ID, label: "Custom" },
    ]);
  });

  it("groups a nested gateway id by its full provider path", () => {
    // The gateway's own first segment is shared by every upstream it fronts;
    // heading the rows with it left six same-named models under one heading.
    const options = modelPickerOptions(
      [
        { id: "gw/dashscope/glm-5.3[1m]", label: "GLM 5.3" },
        { id: "gw/volcengine/glm-5.3[1m]", label: "GLM 5.3" },
        { id: "gw/glm-5.3[1m]", label: "GLM 5.3" },
      ],
      { default: "Default", custom: "Custom" },
    );
    expect(options.slice(1, -1)).toEqual([
      {
        id: "gw/dashscope/glm-5.3[1m]",
        label: "GLM 5.3",
        detail: "gw/dashscope",
        group: "gw/dashscope",
      },
      {
        id: "gw/volcengine/glm-5.3[1m]",
        label: "GLM 5.3",
        detail: "gw/volcengine",
        group: "gw/volcengine",
      },
      { id: "gw/glm-5.3[1m]", label: "GLM 5.3", detail: "gw", group: "gw" },
    ]);
  });

  it("lists a repeated catalog id once, keeping the first row", () => {
    const options = modelPickerOptions(
      [
        { id: "gw/opus", label: "Opus" },
        { id: " gw/opus ", label: "Opus (duplicate)" },
        { id: "gw/sonnet", label: "Sonnet" },
      ],
      { default: "Default", custom: "Custom" },
    );
    expect(options.map((option) => option.label)).toEqual(["Default", "Opus", "Sonnet", "Custom"]);
  });
});
